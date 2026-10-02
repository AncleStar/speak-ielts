export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** 越权与不存在统一返回 404 */
export const notFound = (what = "资源") => new AppError(404, "not_found", `${what}不存在`);
export const badRequest = (msg: string, code = "bad_request") => new AppError(400, code, msg);
export const conflict = (msg: string, code = "conflict") => new AppError(409, code, msg);
export const forbidden = (msg = "没有权限", code = "forbidden") => new AppError(403, code, msg);
