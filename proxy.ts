import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";

/**
 * Next.js 16：middleware 已更名为 proxy。
 * 这里只做"没有登录 Cookie 就跳到登录页"的乐观跳转；真正的鉴权以服务端布局与接口校验为准。
 * 不匹配 /api，避免代理层缓冲录音上传请求体。
 */
export function proxy(req: NextRequest) {
  // Runtime data is supplied by the deployer, never bundled into the application image.
  if (["restore-pending.json", "restore-review-pending.json"].some(file => fs.existsSync(/* turbopackIgnore: true */ path.resolve(/* turbopackIgnore: true */ process.env.DATA_DIR || "./data", file)))) {
    const url = req.nextUrl.clone(); url.pathname = "/maintenance"; url.search = "";
    return NextResponse.redirect(url);
  }
  if (["/login", "/register", "/password-help"].includes(req.nextUrl.pathname)) return NextResponse.next();
  const cookie = getSessionCookie(req);
  if (!cookie) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|maintenance|fonts/|licenses/|_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)"],
};
