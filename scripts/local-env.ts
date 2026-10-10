import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { loadDotEnv } from "./_env";

/** First-use commands share configuration creation; an existing file is never overwritten. */
export function ensureLocalEnv(root = process.cwd()) {
  const file = path.join(root, ".env"); let created = false;
  if (!fs.existsSync(file)) {
    const template = fs.readFileSync(path.join(root, ".env.example"), "utf8")
      .replace(/^BETTER_AUTH_SECRET=.*$/m, `BETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}`)
      .replace(/^ADMIN_INITIAL_PASSWORD=.*$/m, `ADMIN_INITIAL_PASSWORD=${randomBytes(18).toString("base64url")}`);
    try { fs.writeFileSync(file, template, { flag: "wx", mode: 0o600 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  loadDotEnv(file); return created;
}
