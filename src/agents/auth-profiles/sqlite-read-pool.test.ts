import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { openSqliteReadOnlyDatabase as openReader } from "../../infra/sqlite-snapshot-source.js";
import { readDatabasePathIdentitySync as pathIdentity } from "../../infra/sqlite-worker-identity.js";
import { readAuthProfileRowsReadOnly as readRows } from "./sqlite-json.js";
import { closeAuthProfileReadPool } from "./sqlite-read-pool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const credentials = (key: string) => ({ profiles: { fixture: { key } } });

function createDatabase(databasePath: string, store: object) {
  using writer = openNodeSqliteDatabase(databasePath);
  writer.exec(`
      CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT);
      CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT);
    `);
  writer.prepare("INSERT INTO auth_profile_store VALUES ('primary', ?)").run(JSON.stringify(store));
}

const readerArgs = (file: string) => [file, openReader, undefined, pathIdentity(file).key] as const;
const read = (file: string) => readRows(...readerArgs(file));

it.skipIf(process.platform === "win32")("does not reuse credentials from a replaced file", () => {
  const databasePath = path.join(tempDirs.make("auth-reader-replacement-"), "agent.sqlite");
  try {
    createDatabase(databasePath, credentials("old-synthetic-key"));
    expect(read(databasePath).store).toMatchObject({ raw: credentials("old-synthetic-key") });
    createDatabase(`${databasePath}.replacement`, credentials("new-synthetic-key"));
    fs.renameSync(databasePath, `${databasePath}.old`);
    fs.renameSync(`${databasePath}.replacement`, databasePath);
    expect(read(databasePath).store).toMatchObject({ raw: credentials("new-synthetic-key") });
  } finally {
    closeAuthProfileReadPool({ kind: "database", databasePath });
  }
});
