import fs from "node:fs/promises";
import crypto from "node:crypto";
import { loadContent } from "@/lib/content/load";
import { checkIntegrity } from "@/lib/content/validate";
const bundle = loadContent();
const entry = bundle.levels.filter(l => l.chapter === 1).flatMap(l => l.questions), mock = bundle.mocks[0];
const ids = new Set([...entry, ...mock.part1, mock.part2, ...mock.part3]);
const questions = bundle.questions.filter(q => ids.has(q.id));
const report = checkIntegrity(bundle);
if (!report.ok || entry.length !== 20 || questions.length !== 30) throw new Error("首批范围或题库结构检查失败");
const rows = questions.map(q => ({ id: q.id, scope: entry.includes(q.id) ? "入门 / 部分同时用于模考1" : "模考1", difficulty: q.difficulty,
  goal: q.trainingGoal, referenceWords: q.referenceAnswer.split(/\s+/).length,
  fingerprint: crypto.createHash("sha256").update(JSON.stringify(q)).digest("hex"),
  contentStatus: q.reviewStatus, humanTeachingReview: "pending" }));
await fs.mkdir("docs", { recursive: true });
await fs.writeFile("docs/首批题库核对清单.json", JSON.stringify({ generatedAt: new Date().toISOString(), reviewer: "AI content review, not a human examiner", scope: { entry: 20, mock: "mock-1", uniqueMainQuestions: 30, followups: 6, rounding: 1 }, rows }, null, 2));
await fs.writeFile("docs/首批题库内容核对.md", [
  "# 首批题库内容核对", "", "范围：第 1 章 20 道入门题 + 模考 1，去重后共 30 道主问题；另核对该模考的 6 道追问与 1 道收尾题。", "",
  "本次是 AI 内容核对和程序检查，尚未完成人工教学审核。全部原始审核状态保留，未自动标记 approved。对应内容指纹见同目录 JSON；后续内容变化需重新核对。", "",
  "## 本轮实际修改", "",
  "- 20 道入门题分别增加可观察的训练目标，允许不同生活经历和表达，不要求照抄范文。",
  "- HOME-1 的 house 中文释义避免限定为独栋；参考回答简化为更清楚的短句。",
  "- ROUTINE-3 修正项目组搭配；ROUTINE-4 明确比较周末和工作日的 routine。",
  "- FOOD-2 去掉做饭必然更健康的绝对说法；FOOD-4 用需要特定设备的菜替代不合适的火锅例子。",
  "- 明确 closer/closest 的比较级和最高级；family 的英式主谓一致、food/foods 和季节冠词允许正常变体。",
  "- HOME-4 区分 used to 描述过去状态与现在完成时概括变化；不把正常的时态对比当成错误。",
  "- 模考 Part 2 公共场所题改为描述性组织目标，不强制把地点介绍写成故事。", "",
  "## 逐题核对范围", "", "检查英文题意、中文对应、参考回答贴题性、可用表达、常见困难、训练目标和难度标注；未修改项表示本次未发现明确问题，不代表完成教学校准。", "",
  "| 题号 | 范围 | 难度 | 训练目标 | 范文词数 | 人工审核 |", "| --- | --- | --- | --- | --- | --- |",
  ...rows.map(r => `| ${r.id} | ${r.scope} | ${r.difficulty} | ${r.goal} | ${r.referenceWords} | 待审 |`), "",
  "## 模考编排核对", "", "模考1：居住与家乡、购物的短问答 → 公共场所个人陈述 → 社区公共空间的讨论。Part 3 三道主问题及其追问均延续公共场所主题；收尾题保持简短具体。", "",
  "本应用使用 12 分 30 秒的固定训练模板；官方口语考试为 11–14 分钟，分三个部分。Part 2 的准备时间为 1 分钟，陈述最长 2 分钟。具体题数与流程属于应用练习设置，不宣称官方真题或押题。[IELTS 官方题型说明](https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-speaking)", "",
  "后续人工验收：由英语教师核对不同正确表达的容忍度、入门难度、自然度和个体适配，记录审核人和意见后，再通过后台发布审核状态。",
].join("\n") + "\n");
console.log(`首批清单已生成：${questions.length} 道主问题；人工教学审核仍待完成。`);
