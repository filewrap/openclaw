import { getOsc8LinkAtColumn } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { addOsc8Hyperlinks, extractUrls } from "./osc8-hyperlinks.js";

const link = (url: string, text = url) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

const pathUrl = "https://example.com/path";
const ipv6 = "http://[::1]:8080/path";
const wikipedia = "https://en.wikipedia.org/wiki/URL_(disambiguation)";
const query = "https://example.com/v1.0/URL_(disambiguation)?a=1&b=2#section";
const domain = "https://example.com";
const wrapped = "https://example.com/a/very/long/path/that/keeps/going/and/going";

describe("extractUrls", () => {
  it.each([
    ["sentence punctuation", `Visit ${pathUrl}.`, [pathUrl]],
    ["GFM punctuation", `Visit ${pathUrl}.?!`, [pathUrl]],
    ["bidi isolate", `مرحبا ${pathUrl}\u2069`, [pathUrl]],
    ["bidi mark", `مرحبا ${pathUrl}\u200f`, [pathUrl]],
    ["markdown", `[Click here](${pathUrl})`, [pathUrl]],
    ["authored suffix", `[Click here](${pathUrl}.)`, [`${pathUrl}.`]],
    ["angle brackets and title", `[Click here](<${pathUrl}> "Example Title")`, [pathUrl]],
    [
      "rejected destination label",
      "[https://label.test](https://.) https://bare.test",
      ["https://bare.test"],
    ],
    ["no URLs", "No links here", []],
    ["IPv6", ipv6, [ipv6]],
    ["markdown parentheses", `[Wikipedia](${wikipedia})`, [wikipedia]],
    ["balanced parentheses and query", `Visit ${query}.`, [query]],
    ["incomplete destination", "[broken](https://)", []],
    ["invalid markdown authority", "[broken](https://.)", []],
    ["invalid bare authority", "https://.", []],
    ["missing authority", "https:///path", []],
    ["unmatched parenthesis", `(see ${pathUrl}).`, [pathUrl]],
  ] satisfies [string, string, string[]][])("extracts %s", (_name, markdown, expected) => {
    expect([...extractUrls(markdown)]).toStrictEqual(expected);
  });
  it("keeps authored destinations before bare URLs in first-seen order", () => {
    const md =
      "https://api.example.com [Docs](https://docs.example.com) " +
      "[Guide](https://guide.example.com) [Docs again](https://docs.example.com)";
    expect([...extractUrls(md)]).toEqual([
      "https://docs.example.com",
      "https://guide.example.com",
      "https://api.example.com",
    ]);
  });
});

describe("addOsc8Hyperlinks", () => {
  it.each([
    { name: "BEL", params: "", terminator: "\x07" },
    { name: "ST with link identity", params: "id=docs", terminator: "\x1b\\" },
  ])("preserves authored spans alongside unlinked URLs ($name)", ({ params, terminator }) => {
    const label = "https://example.test/label";
    const target = "https://example.test/destination";
    const bare = "https://example.test/bare";
    const prefix = "See ";
    const authored = `\x1b]8;${params};${target}${terminator}\x1b[32m${label}\x1b[0m\x1b]8;;${terminator}`;
    const line = `${prefix}${authored} then ${bare}`;

    const [rendered] = addOsc8Hyperlinks([line], new Set([target, bare]));

    expect(rendered).toContain(authored);
    expect(getOsc8LinkAtColumn(rendered!, prefix.length)).toBe(target);
    expect(getOsc8LinkAtColumn(rendered!, prefix.length + label.length)).toBeUndefined();
    expect(getOsc8LinkAtColumn(rendered!, prefix.length + label.length + " then ".length)).toBe(
      bare,
    );
  });

  it.each([
    ["empty URL set", ["Hello world", "No links here"], []],
    ["no URL text", ["Just some text", "No URLs here"], ["https://example.com"]],
    ["partial domain", ["https://", "example.org"], ["https://example.com"]],
    ["longer token", ["https://", "example.com/pathology"], [pathUrl]],
    ["punctuation-only body", ["https://."], ["https://."]],
  ] satisfies [string, string[], string[]][])("leaves %s unchanged", (_name, lines, urls) => {
    expect(addOsc8Hyperlinks(lines, new Set(urls))).toEqual(lines);
  });

  it.each([
    ["plain", "Visit ", domain, " for info"],
    ["Unicode", "🦞 東京 ", `${domain}/😀/e\u0301`, " 🧑‍💻"],
    ["lone surrogates", "\ud800 ", `${domain}/\udfff`, " \udc00"],
    ["bidi isolation", "\u2067مرحبا ", pathUrl, "\u2069"],
    ["IPv6", "", ipv6, ""],
    ["parentheses", "Wikipedia (", wikipedia, ")"],
  ])("wraps %s URLs", (_name, prefix, url, suffix) => {
    expect(addOsc8Hyperlinks([`${prefix}${url}${suffix}`], new Set([url]))).toEqual([
      `${prefix}${link(url)}${suffix}`,
    ]);
  });

  it.each([
    ["sentence punctuation", `Visit ${pathUrl}.`, `Visit ${pathUrl}.`, `Visit ${link(pathUrl)}.`],
    ["GFM punctuation", `Visit ${pathUrl}.?!`, `Visit ${pathUrl}.?!`, `Visit ${link(pathUrl)}.?!`],
    [
      "authored punctuation",
      `[Docs](${pathUrl}.)`,
      `Docs (${pathUrl}.)`,
      `Docs (${link(`${pathUrl}.`)})`,
    ],
    [
      "authored and bare occurrences",
      `[Docs](${pathUrl}.) and ${pathUrl}.`,
      `Docs (${pathUrl}.) and ${pathUrl}.`,
      `Docs (${link(`${pathUrl}.`)}) and ${link(pathUrl)}.`,
    ],
  ])("preserves %s targets", (_name, markdown, line, expected) => {
    expect(addOsc8Hyperlinks([line], extractUrls(markdown))).toEqual([expected]);
  });

  it.each([
    ["scheme split", pathUrl, ["https://", "example.com/path"]],
    [
      "three lines",
      wrapped,
      ["https://example.com/a/very/lon", "g/path/that/keeps/going/and/g", "oing"],
    ],
  ] satisfies [string, string, string[]][])("wraps %s", (_name, url, lines) => {
    expect(addOsc8Hyperlinks(lines, new Set([url]))).toEqual(lines.map((line) => link(url, line)));
  });

  it("keeps a whole code point when a wrapped continuation matches only its high surrogate", () => {
    const url = `${domain}/😀/path`;
    expect(addOsc8Hyperlinks([`${domain}/`, "😁 next"], new Set([url]))).toEqual([
      link(url, `${domain}/`),
      `${link(url, "😁")} next`,
    ]);
  });

  it("handles URL with ANSI styling codes", () => {
    const result = addOsc8Hyperlinks([`\x1b[32m${domain}\x1b[0m`], new Set([domain]));
    expect(result).toEqual([`\x1b[32m${link(domain, `${domain}\x1b[0m`)}`]);
  });

  it.each([
    ["longest prefix", ["a", "ab"], "", "ab"],
    ["exact match before longer prefix", ["ab", "a"], "a", "a"],
    ["first equal-length prefix", ["ab", "aa"], "a", "ab"],
  ] as const)("resolves a rendered fragment by %s", (_name, known, fragment, expected) => {
    const url = (suffix: string) => `https://example.test/${suffix}`;
    expect(addOsc8Hyperlinks([url(fragment)], new Set(known.map(url)))).toEqual([
      link(url(expected), url(fragment)),
    ]);
  });

  it("does not resolve an incomplete URL to another known URL", () => {
    expect(addOsc8Hyperlinks(["broken (https://)", domain], new Set([domain]))).toEqual([
      "broken (https://)",
      link(domain),
    ]);
  });
});
