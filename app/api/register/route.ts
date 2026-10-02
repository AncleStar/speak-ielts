import { z } from "zod";
import { handle, json, readJson } from "@/lib/auth-server";
import { badRequest } from "@/lib/errors";
import { assertOrigin } from "@/lib/request-origin";
import { registerWithInvite } from "@/lib/services/invites";
const schema = z.object({ email: z.email().max(254), name: z.string().trim().min(1).max(60),
  password: z.string().min(8).max(128), code: z.string().trim().min(12).max(80) });
export const POST = handle(async (req: Request) => {
  assertOrigin(req);
  const input = schema.safeParse(await readJson(req));
  if (!input.success) throw badRequest("请填写有效邮箱、昵称、邀请码和 8–128 位密码");
  return json(await registerWithInvite(input.data), { status: 201 });
});
