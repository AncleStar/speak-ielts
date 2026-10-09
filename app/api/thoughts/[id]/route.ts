import { apiUser, handle, json, readJson } from "@/lib/auth-server";
import { assertOrigin } from "@/lib/request-origin";
import { deleteThought, editThought, getThought } from "@/lib/services/thoughts";
type Context = { params: Promise<{ id: string }> };
export const GET = handle(async (_req: Request, ctx: Context) => json(await getThought((await apiUser()).id, (await ctx.params).id)));
export const PUT = handle(async (req: Request, ctx: Context) => { assertOrigin(req); return json(await editThought((await apiUser()).id, (await ctx.params).id, await readJson(req))); });
export const DELETE = handle(async (req: Request, ctx: Context) => { assertOrigin(req); return json(await deleteThought((await apiUser()).id, (await ctx.params).id)); });
