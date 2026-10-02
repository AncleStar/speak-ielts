import { z } from "zod";
import { apiUser, handle, json, readJson } from "@/lib/auth-server";
import { badRequest } from "@/lib/errors";
import { assertOrigin } from "@/lib/request-origin";
import { createInvite, revokeInvite } from "@/lib/services/invites";
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), email: z.union([z.email().max(254), z.literal("")]), days: z.number().int().min(1).max(30) }),
  z.object({ action: z.literal("revoke"), id: z.string().uuid() }),
]);
export const POST = handle(async (req: Request) => {
  assertOrigin(req); const u = await apiUser({ admin: true });
  const input = schema.safeParse(await readJson(req));
  if (!input.success) throw badRequest("请检查邮箱和有效天数（1–30 天）");
  if (input.data.action === "revoke") { await revokeInvite(input.data.id); return json({ ok: true }); }
  return json(await createInvite(u.id, input.data.email, input.data.days));
});
