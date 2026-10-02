import { apiUser, handle, json } from "@/lib/auth-server";
import { getLevelMap } from "@/lib/services/reports";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const u = await apiUser();
  return json(await getLevelMap(u.id));
});
