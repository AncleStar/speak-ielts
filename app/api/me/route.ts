import { apiUser, handle, json } from "@/lib/auth-server";
import { getQuotaStatus } from "@/lib/quota";

export const dynamic = "force-dynamic";

/** 当前用户偏好与今日额度 */
export const GET = handle(async () => {
  const u = await apiUser({ allowMustChange: true });
  return json({
    user: {
      id: u.id,
      name: u.name,
      email: u.email,
      isAdmin: u.isAdmin,
      subtitlePref: u.subtitlePref,
      consentAt: u.consentAt,
      mustChangePassword: u.mustChangePassword,
    },
    quota: await getQuotaStatus(u.id),
  });
});
