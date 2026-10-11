import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const run = promisify(execFile), project = process.cwd();
async function checkDeployment(files: string[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "speak-deployment-check-"));
  const traceDir = path.join(root, ".next/server/app"), privateMarker = "private-fixture-content-not-for-logs";
  try {
    await fs.mkdir(traceDir, { recursive: true });
    for (const name of files) { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, privateMarker); }
    await fs.writeFile(path.join(traceDir, "page.js.nft.json"), JSON.stringify({ version: 1, files: files.map(file => path.relative(traceDir, path.join(root, file))) }));
    let code = 0, output = "";
    try { const result = await run(process.execPath, ["--import", pathToFileURL(path.join(project, "node_modules/tsx/dist/loader.mjs")).href, path.join(project, "scripts/check-build-isolation.ts")], { cwd: root, timeout: 10000, windowsHide: true }); output = result.stdout + result.stderr; }
    catch (error) { const result = error as Error & { code: number; stdout: string; stderr: string }; code = result.code; output = result.stdout + result.stderr; }
    const report = JSON.parse(await fs.readFile(path.join(root, "data/verification/build-isolation.json"), "utf8"));
    expect(output).not.toContain(privateMarker);
    return { code, report };
  } finally {
    const resolved = await fs.realpath(root), temp = await fs.realpath(os.tmpdir());
    if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith("speak-deployment-check-")) throw new Error("Temporary deployment check directory changed");
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
it("refuses a real deployment trace that includes local test reports, caches and authoring files", async () => {
  const { code, report } = await checkDeployment(["test-results/recording.webm", "playwright-report/index.html", ".next/cache/build.log", "art/local-disc.blend", "tsconfig.tsbuildinfo"]);
  expect(code).toBe(1); expect(report.passed).toBe(false); expect(report.findings).toHaveLength(5);
});
it("accepts a trace of the compiled route, application manifest and necessary runtime dependency", async () => {
  const { code, report } = await checkDeployment([".next/server/app/page.js", "package.json", "node_modules/pg/lib/index.js"]);
  expect(code).toBe(0); expect(report.passed).toBe(true); expect(report.references).toBe(3); expect(report.findings).toEqual([]);
});
