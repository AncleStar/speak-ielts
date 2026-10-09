import { apiUser, handle, json, readJson } from "@/lib/auth-server";
import { assertOrigin } from "@/lib/request-origin";
import { generateThought, listThoughts } from "@/lib/services/thoughts";
import { thoughtListParams } from "@/lib/thoughts/schema";
export const GET = handle(async (req: Request) => { const u = await apiUser(); const p = thoughtListParams(req); return json(await listThoughts(u.id, p.query, p.offset)); });
export const POST = handle(async (req: Request) => { assertOrigin(req); const u = await apiUser(); return json(await generateThought(u.id, await readJson(req))); });
