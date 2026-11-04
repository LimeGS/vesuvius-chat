import { closeSync, constants, openSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function initializeQuotaDatabase(path) {
  if (!isAbsolute(path)) throw new Error("Quota path must be absolute");
  closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600));
  const db = new DatabaseSync(path);
  try {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE quotas (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL);
      INSERT INTO quotas VALUES (1, '{"counters":{},"leases":{}}'); COMMIT`);
  } finally { db.close(); }
}

if (import.meta.main) {
  initializeQuotaDatabase(process.argv[2]);
  console.log("Private quota storage initialized. Existing databases are never overwritten.");
}
