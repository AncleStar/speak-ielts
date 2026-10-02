import { z } from "zod";
import { apiUser, handle, json, readJson } from "@/lib/auth-server";
import { forbidden, badRequest } from "@/lib/errors";
import { checkIn, getRewards, markReviewed, redeemMinutes } from "@/lib/services/rewards";

export const GET = handle(async () => json(await getRewards((await apiUser()).id)));
const body = z.discriminatedUnion("action", [z.object({ action: z.literal("checkin") }), z.object({ action: z.literal("redeem"), requestId: z.string(), offer: z.object({ cost: z.number().int(), minutes: z.number().int(), days: z.number().int() }).optional() }), z.object({ action: z.literal("review"), answerId: z.string().max(100) })]);
export const POST = handle(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(process.env.BETTER_AUTH_URL ?? req.url).origin) throw forbidden("请在本站完成操作");
  const u = await apiUser();
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) throw badRequest("参数错误");
  const input = parsed.data;
  if (input.action === "checkin") return json(await checkIn(u.id));
  if (input.action === "redeem") return json(await redeemMinutes(u.id, input.requestId, new Date(), input.offer));
  await markReviewed(u.id, input.answerId); return json({ ok: true });
});
