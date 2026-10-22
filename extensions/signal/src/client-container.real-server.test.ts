import { writeFile } from "node:fs/promises";
import type http from "node:http";
import { join } from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { containerRpcRequest } from "./client-container.js";
import { useSignalHttpServer } from "./client.test-support.js";

const startServer = useSignalHttpServer();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const params = { account: "+15550001111", recipient: ["+15551234567"], message: "Photo" };
afterEach(() => {
  vi.restoreAllMocks();
});
function accept(res: http.ServerResponse) {
  res.writeHead(201, { "content-type": "application/json" });
  res.end(JSON.stringify({ timestamp: "1735689600000" }));
}

describe("container REST real server", () => {
  it("preserves a send accepted before its caller closes", async () => {
    const caller = new AbortController();
    const baseUrl = await startServer((_req, res) => {
      caller.abort(new Error("Signal caller closed after transmission"));
      accept(res);
    });
    await expect(
      containerRpcRequest("send", params, {
        baseUrl,
        assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
      }),
    ).resolves.toEqual({ timestamp: 1735689600000 });
  });
  it("rejects malformed UTF-8 before JSON parsing", async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        Buffer.concat([Buffer.from('{"versions":["'), Buffer.from([0xff]), Buffer.from('"]}')]),
      );
    });
    await expect(containerRpcRequest("version", undefined, { baseUrl })).rejects.toBeInstanceOf(
      TypeError,
    );
  });
  it("aborts an unfinished response at its deadline and closes the connection", async () => {
    let flushed = false;
    let closed = false;
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{", (error) => {
        flushed = !error;
      });
      const drip = setInterval(() => res.write(" "), 50);
      res.on("close", () => {
        clearInterval(drip);
        closed = true;
      });
    });
    const start = Date.now();
    await expect(
      containerRpcRequest("version", undefined, { baseUrl, timeoutMs: 300 }),
    ).rejects.toThrow("Signal REST request timed out");
    expect(flushed).toBe(true);
    expect(Date.now() - start).toBeLessThan(2_000);
    await expect.poll(() => closed).toBe(true);
  });
  it("posts a provider-safe original attachment filename and intact bytes", async () => {
    let received: unknown;
    const baseUrl = await startServer((req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/v2/send");
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        accept(res);
      });
    });
    const content = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const file = join(
      tempDirs.make("signal-filename-"),
      "mixed;semi;comma,comma,hash#name---a1b2c3d4-5678-90ab-cdef-1234567890ab.jpg",
    );
    await writeFile(file, content);
    await expect(
      containerRpcRequest(
        "send",
        { ...params, attachments: [file] },
        { baseUrl, timeoutMs: 1_000 },
      ),
    ).resolves.toEqual({ timestamp: 1735689600000 });
    const dataUri = "data:image/jpeg;filename=mixed_semi_comma_comma_hash_name.jpg;base64,/9j/4A==";
    expect(received).toEqual({
      message: params.message,
      number: params.account,
      recipients: params.recipient,
      base64_attachments: [dataUri],
    });
    expect(Buffer.from(await (await fetch(dataUri)).arrayBuffer())).toEqual(content);
  });
});
