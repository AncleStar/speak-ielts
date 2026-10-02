import { apiUser, handle, json, readJson } from "@/lib/auth-server";
import { assertOrigin } from "@/lib/request-origin";
import { saveAiConfig, deleteApiKey } from "@/lib/ai/credentials";
import { getAiAccount } from "@/lib/ai/account";

export const dynamic = "force-dynamic";
export const GET = handle(async (req: Request) => {
  const u = await apiUser(), search = new URL(req.url).searchParams;
  return json(await getAiAccount(u.id, search.get("month") ?? undefined, Number(search.get("offset") ?? 0)));
});
export const PUT = handle(async (req: Request) => {
  const u = await apiUser(); assertOrigin(req);
  return json(await saveAiConfig(u.id, await readJson(req)));
});
export const DELETE = handle(async (req: Request) => {
  const u = await apiUser(); assertOrigin(req);
  return json(await deleteApiKey(u.id));
});
