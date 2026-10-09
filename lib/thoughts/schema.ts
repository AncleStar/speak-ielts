import { z } from "zod";
import { badRequest } from "@/lib/errors";

export function thoughtListParams(req: Request) {
  const params = new URL(req.url).searchParams; const query = (params.get("q") ?? "").trim(); const offset = Number(params.get("offset") ?? 0);
  if (query.length > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100_000) throw badRequest("搜索参数错误。");
  return { query, offset };
}

export const englishText = (max: number) => z.string().trim().min(3).max(max)
  .refine(text => /[a-zA-Z]/.test(text) && !/[\u3400-\u9fff]/.test(text), "请填写英文表达");
export const vocabularySchema = z.object({ term: englishText(100), meaning: z.string().trim().min(1).max(300), example: englishText(800) });
export const thoughtOutputSchema = z.object({
  title: z.string().trim().min(1).max(80), analysis: z.string().trim().min(1).max(1200),
  simple: englishText(1200), natural: englishText(2000), nuanced: englishText(2800),
  vocabulary: z.array(vocabularySchema).min(1).max(8),
});
export const generateThoughtSchema = z.object({ sourceText: z.string().trim().min(3).max(2000), requestId: z.string().uuid() }).strict();
export const editThoughtSchema = z.object({
  revision: z.number().int().nonnegative(), title: z.string().trim().min(1).max(80),
  sourceText: z.string().trim().min(3).max(2000), simple: englishText(1200), natural: englishText(2000), nuanced: englishText(2800),
}).strict();
export const practiceSchema = z.object({
  action: z.literal("practice"), revision: z.number().int().nonnegative(), requestId: z.string().uuid(),
  outcome: z.enum(["practice", "again", "remembered"]), recalledText: z.string().trim().max(2800).default(""),
  durationSeconds: z.number().finite().min(0).max(300).default(0),
}).strict();
export const reviewActionSchema = z.union([
  z.object({ action: z.enum(["enroll", "remove"]), revision: z.number().int().nonnegative() }).strict(), practiceSchema,
]);
export const saveVocabularySchema = z.object({ thoughtId: z.string().uuid(), revision: z.number().int().nonnegative(), indices: z.array(z.number().int().min(0).max(7)).min(1).max(8) }).strict();
export const editVocabularySchema = z.object({ term: englishText(100), meaning: z.string().trim().min(1).max(300), example: z.string().trim().max(800) }).strict();
export function normalizeTerm(term: string) { return term.normalize("NFKC").toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim(); }
export function containsTerm(text: string, term: string) { return normalizeTerm(text).includes(normalizeTerm(term)); }

export type ThoughtOutput = z.infer<typeof thoughtOutputSchema>;
export type ThoughtEdit = z.infer<typeof editThoughtSchema>;
export type PracticeInput = z.infer<typeof practiceSchema>;
export type ThoughtSummary = { id: string; title: string; sourceText: string; mock: boolean; updatedAt: string };
export type ThoughtDetail = ThoughtOutput & { id: string; sourceText: string; model: string; mock: boolean; edited: boolean; revision: number; createdAt: string; updatedAt: string;
  review: null | { completedCount: number; nextDueAt: string; lastReviewedAt: string | null };
  practices: { id: string; outcome: string; durationSeconds: number; recalledText: string; naturalText: string; createdAt: string }[] };
export type VocabularyView = { id: string; term: string; meaning: string; example: string; thoughtId: string | null; updatedAt: string };
export type ThoughtList = { items: ThoughtSummary[]; total: number; offset: number; pageSize: number };
export type VocabularyList = { items: VocabularyView[]; total: number; offset: number; pageSize: number };
