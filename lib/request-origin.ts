import { AppError } from "@/lib/errors";
import { env, type Env } from "@/lib/env";

type OriginConfig = Pick<Env, "BETTER_AUTH_URL" | "APP_DOMAIN">;
function originOf(value: string) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hostname.includes("*")) return null;
    return url.origin;
  } catch { return null; }
}

/** Only explicit configured origins authorize writes; client-supplied host/proxy headers do not. */
export function trustedRequestOrigins(config: OriginConfig, additional = process.env.TRUSTED_ORIGINS ?? "") {
  const candidates = [config.BETTER_AUTH_URL, ...additional.split(",").map(value => value.trim()).filter(Boolean)];
  if (config.APP_DOMAIN && config.APP_DOMAIN !== "localhost") candidates.push(`https://${config.APP_DOMAIN}`);
  return new Set(candidates.map(originOf).filter((origin): origin is string => origin !== null));
}

/** Browser writes require a trusted Origin, or a trusted Referer when Origin is absent. */
export function assertRequestOrigin(request: Request, config: OriginConfig = env(), additional?: string) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return;
  const trusted = trustedRequestOrigins(config, additional);
  const origin = request.headers.get("origin"), referer = request.headers.get("referer");
  // A supplied invalid/null origin cannot be rescued by Referer or Fetch Metadata.
  const source = origin !== null ? originOf(origin) : referer ? originOf(referer) : null;
  const canonicalOrigin = origin === null || origin === source;
  if (!source || !canonicalOrigin || !trusted.has(source))
    throw new AppError(403, "untrusted_origin", "请求来源未通过校验，请从本站页面重试；部署者需核对网站地址配置。");
}

// Existing routes keep their explicit guard as well as the shared API wrapper.
export const assertOrigin = assertRequestOrigin;
