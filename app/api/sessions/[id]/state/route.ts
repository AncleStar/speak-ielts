import { apiUser, handle, json } from "@/lib/auth-server";
import { getSessionState } from "@/lib/services/sessions";

export const dynamic = "force-dynamic";
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const u = await apiUser();
  return json(await getSessionState(u.id, (await ctx.params).id), { headers: { "Cache-Control": "private, no-store" } });
});
