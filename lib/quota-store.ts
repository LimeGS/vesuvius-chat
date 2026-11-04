import { DatabaseSync } from "node:sqlite";
import { closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";
import { isAbsolute } from "node:path";
import { applyLimits, type LimitInput, type LimitResult, type LimitState } from "./quota";

export function applyPersistentLimits(databasePath: string, input: LimitInput, now: number): LimitResult {
  if (!isAbsolute(databasePath)) throw new Error("Quota path must be absolute");
  const fd = openSync(databasePath, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Quota storage must be a regular file");
    fchmodSync(fd, 0o600);
  } finally { closeSync(fd); }
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA temp_store=MEMORY");
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare("SELECT state FROM quotas WHERE id=1").get();
    if (!row) throw new Error("Quota state is missing");
    const state: LimitState = JSON.parse(String(row.state));
    for (const item of [state, ...(state?.mcp === undefined ? [] : [state.mcp])]) {
      if (!item || typeof item !== "object" || !item.counters || !item.leases || Array.isArray(item.counters) || Array.isArray(item.leases)
        || Object.values(item.counters).some(counter => !counter || !Number.isSafeInteger(counter.count) || counter.count < 1 || !Number.isSafeInteger(counter.expires))
        || Object.values(item.leases).some(expiry => !Number.isSafeInteger(expiry))) throw new Error("Invalid quota state");
    }
    const result = applyLimits(state, input, now);
    db.prepare("UPDATE quotas SET state=? WHERE id=1").run(JSON.stringify(state));
    db.exec("COMMIT");
    return result;
  } finally { db.close(); }
}
