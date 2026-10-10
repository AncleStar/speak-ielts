import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd(), findings: { trace: string; rule: string }[] = [];
let traces = 0, references = 0;
async function visit(directory: string) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (entry.name.endsWith(".nft.json")) {
      traces++;
      const trace = JSON.parse(await fs.readFile(file, "utf8"));
      if (!Array.isArray(trace.files)) throw new Error("构建追踪格式无效");
      for (const reference of trace.files) {
        references++;
        const relative = path.relative(root, path.resolve(directory, reference)).split(path.sep).join("/");
        if (relative.startsWith("../") || path.isAbsolute(relative)) findings.push({ trace: path.relative(root, file), rule: "引用工作区之外的文件" });
        if (/^(?:data|backups|release|\.git)\//.test(relative) || /^\.env(?:$|\.)/.test(relative)) findings.push({ trace: path.relative(root, file), rule: "引用私有配置或运行数据" });
      }
    }
  }
}
try {
  await visit(path.join(root, ".next"));
  const report = { checkedAt: new Date().toISOString(), scope: "Next.js deployment trace references; does not inspect arbitrary bundled secrets", traces, references, findings, passed: traces > 0 && findings.length === 0 };
  await fs.mkdir(path.join(root, "data/verification"), { recursive: true });
  await fs.writeFile(path.join(root, "data/verification/build-isolation.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ traces, references, findings: findings.length, passed: report.passed }));
  if (!report.passed) process.exitCode = 1;
} catch { console.error("构建隔离检查失败，请先完成生产构建并检查部署追踪清单。"); process.exitCode = 1; }
