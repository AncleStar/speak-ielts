import { apiUser, handle, json } from "@/lib/auth-server";
import { checkVoiceReadiness } from "@/lib/services/voice-readiness";
export const dynamic = "force-dynamic";
export const GET = handle(async () => {
  await apiUser({ admin: true });
  const status = await checkVoiceReadiness();
  await apiUser({ admin: true });
  return json(status);
});
