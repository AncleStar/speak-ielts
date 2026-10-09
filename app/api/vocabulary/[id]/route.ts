import { apiUser, handle, json, readJson } from "@/lib/auth-server";
import { assertOrigin } from "@/lib/request-origin";
import { deleteVocabulary, editVocabulary } from "@/lib/services/thoughts";
type Context = { params: Promise<{ id: string }> };
export const PUT = handle(async (req: Request, ctx: Context) => { assertOrigin(req); return json(await editVocabulary((await apiUser()).id, (await ctx.params).id, await readJson(req))); });
export const DELETE = handle(async (req: Request, ctx: Context) => { assertOrigin(req); return json(await deleteVocabulary((await apiUser()).id, (await ctx.params).id)); });
