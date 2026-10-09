import { z } from "zod";

const entrySchema = z.object({
  id: z.string().min(1).max(200), kind: z.enum(["session", "user", "thought", "vocabulary"]),
  targetId: z.string().min(1).max(200), userId: z.string().min(1).max(200).nullable().default(null),
  at: z.string().refine(v => Number.isFinite(Date.parse(v)), "invalid deletion date"),
});
export type DeletionEntry = z.infer<typeof entrySchema>;

export function parseDeletionLog(text: string): DeletionEntry[] {
  try { return text.split(/\r?\n/).filter(line => line.trim()).map(line => entrySchema.parse(JSON.parse(line))); }
  catch { throw new Error("删除日志损坏，禁止继续恢复"); }
}

/** Merge old and latest intents; conflicting IDs indicate damaged or mismatched logs. */
export function mergeDeletionLogs(...texts: string[]) {
  const entries = new Map<string, DeletionEntry>();
  for (const text of texts) for (const entry of parseDeletionLog(text)) {
    const previous = entries.get(entry.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) throw new Error("删除日志包含冲突记录，禁止继续恢复");
    entries.set(entry.id, entry);
  }
  return [...entries.values()].map(entry => JSON.stringify(entry) + "\n").join("");
}
