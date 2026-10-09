import { z } from "zod";
import { practiceSchema } from "./schema";
export const DRAFT_TTL_MS = 24 * 3600_000;
const fields = z.object({ sourceText: z.string().max(2000), title: z.string().max(80), simple: z.string().max(1200), natural: z.string().max(2000), nuanced: z.string().max(2800) });
const base = { id: z.string().uuid(), userId: z.string().min(1).max(200), localEpoch: z.string().uuid(), savedAt: z.number().int().positive(), thoughtId: z.string().min(1).max(200).nullable(), revision: z.number().int().nonnegative().nullable() };
export const draftSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("edit"), fields, generation: z.object({ sourceText: z.string().max(2000), requestId: z.string().uuid() }).nullable() }),
  z.object({ ...base, kind: z.literal("recall"), recalledText: z.string().max(2800), pending: practiceSchema.nullable() }),
]);
export type ThoughtDraft = z.infer<typeof draftSchema>;
export type DraftFields = z.infer<typeof fields>;
export function validDraft(value: unknown, userId: string, epoch: string, now = Date.now()) {
  const parsed = draftSchema.safeParse(value);
  if (!parsed.success || parsed.data.userId !== userId || parsed.data.localEpoch !== epoch || parsed.data.savedAt > now + 60_000 || now - parsed.data.savedAt >= DRAFT_TTL_MS) return null;
  const row = parsed.data;
  if (row.kind === "recall" && (!row.thoughtId || row.revision === null)) return null;
  if (row.kind === "edit" && ((row.thoughtId === null) !== (row.revision === null))) return null;
  return row;
}
export function draftTitle(row: ThoughtDraft) { return row.kind === "edit" ? row.fields.title || row.fields.sourceText.slice(0, 36) || "未完成观点" : row.recalledText.slice(0, 36) || "未完成回想"; }
