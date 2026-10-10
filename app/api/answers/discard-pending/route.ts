import { z } from "zod";
import { apiUser, handle, json, readJson } from "@/lib/auth-server";
import { badRequest } from "@/lib/errors";
import { discardPendingUpload } from "@/lib/services/answers";
export const dynamic = "force-dynamic";
const schema = z.object({ sessionId: z.string().min(1).max(60), submissionId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/) });
export const POST = handle(async (request: Request) => {
  const user = await apiUser(), input = schema.safeParse(await readJson(request));
  if (!input.success) throw badRequest("参数错误");
  return json(await discardPendingUpload(user.id, input.data.sessionId, input.data.submissionId));
});
