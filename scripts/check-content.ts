/** 题库完整性检查：npm run check:content */
import "./_env";
import { loadContent } from "@/lib/content/load";
import { checkIntegrity } from "@/lib/content/validate";

const bundle = loadContent(undefined, { fresh: true });
const report = checkIntegrity(bundle);
console.log("题库统计：", report.stats);
if (!report.ok) {
  console.error(`发现 ${report.errors.length} 个问题：`);
  for (const e of report.errors) console.error(" -", e);
  process.exit(1);
}
console.log("题库完整性检查通过 ✓");
