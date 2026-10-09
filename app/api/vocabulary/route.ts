import { apiUser, handle, json, readJson } from "@/lib/auth-server";
import { assertOrigin } from "@/lib/request-origin";
import { listVocabulary, saveThoughtVocabulary } from "@/lib/services/thoughts";
import { thoughtListParams } from "@/lib/thoughts/schema";
export const GET = handle(async (req: Request) => { const u = await apiUser(); const p = thoughtListParams(req); return json(await listVocabulary(u.id, p.query, p.offset)); });
export const POST = handle(async (req: Request) => { assertOrigin(req); return json(await saveThoughtVocabulary((await apiUser()).id, await readJson(req))); });
