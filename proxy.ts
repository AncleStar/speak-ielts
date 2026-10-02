import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js 16：middleware 已更名为 proxy。
 * 这里只做"没有登录 Cookie 就跳到登录页"的乐观跳转；真正的鉴权以服务端布局与接口校验为准。
 * 不匹配 /api，避免代理层缓冲录音上传请求体。
 */
export function proxy(req: NextRequest) {
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
  matcher: ["/((?!api|login|register|password-help|fonts/|licenses/|_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)"],
};
