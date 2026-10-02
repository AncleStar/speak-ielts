import { forbidden } from "@/lib/errors";
export function assertOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (origin !== new URL(process.env.BETTER_AUTH_URL ?? req.url).origin) throw forbidden("请在本站完成操作");
}
