import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { initializeQuotaDatabase } from "./init-quota.mjs";

export async function setupAccess(path) {
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    await file.chmod(0o600);
    const text = await file.readFile("utf8");
    const env = parseEnv(text);
    const additions = [];
    if (!env.INVITATION_CODES) additions.push(`INVITATION_CODES='${JSON.stringify([randomBytes(24).toString("base64url")])}'`);
    if (!env.SESSION_SECRET) additions.push(`SESSION_SECRET=${randomBytes(32).toString("base64url")}`);
    if (!env.LIMITS_DB_PATH) {
      const directory = resolve(dirname(path), ".data");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      initializeQuotaDatabase(join(directory, "limits.sqlite"));
      additions.push(`LIMITS_DB_PATH=${JSON.stringify(join(directory, "limits.sqlite"))}`);
    }
    if (additions.length) { await file.appendFile(`\n${additions.join("\n")}\n`); await file.sync(); }
  } finally { await file.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await setupAccess(".env.local");
  console.log("Local access secrets and quota storage are configured in .env.local (0600). Open it privately for the invitation; no secrets were printed. Restart the app.");
}
