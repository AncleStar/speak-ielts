import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
export async function sourceFingerprint(root = process.cwd()) {
  const hash = createHash("sha256");
  async function visit(relative: string) {
    const file = path.join(root, relative), stat = await fs.lstat(file).catch(() => null);
    if (!stat || stat.isSymbolicLink()) return;
    if (stat.isDirectory()) { for (const name of (await fs.readdir(file)).sort()) await visit(path.join(relative, name)); }
    else { hash.update(relative); hash.update(await fs.readFile(file)); }
  }
  for (const entry of ["app", "components", "lib", "content", "db", "worker", "public", "package.json", "package-lock.json", "next.config.ts", "proxy.ts", "postcss.config.mjs", "tsconfig.json"]) await visit(entry);
  return hash.digest("hex");
}
