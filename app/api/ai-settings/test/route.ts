import { apiUser, handle, json } from "@/lib/auth-server";
import { assertOrigin } from "@/lib/request-origin";
import { testPersonalConnection } from "@/lib/ai/account";
export const POST = handle(async (req: Request) => {
  const u = await apiUser(); assertOrigin(req);
  return json(await testPersonalConnection(u.id));
});
