import { apiUser, handle, json } from "@/lib/auth-server";
import { AppError } from "@/lib/errors";
import { parseImportPayload, upsertQuestions } from "@/lib/services/content";

export const dynamic = "force-dynamic";

/** 管理后台导入同结构的题库 JSON：内容变化时自动生成新版本（新版本默认不发布） */
export const POST = handle(async (req: Request) => {
  const u = await apiUser({ admin: true });
  const text = await req.text();
  if (text.length > 5 * 1024 * 1024) throw new AppError(413, "too_large", "文件超过 5 MB");
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new AppError(400, "bad_json", "不是有效的 JSON 文件");
  }
  let items;
  try {
    items = parseImportPayload(payload);
  } catch (e) {
    throw new AppError(400, "bad_format", `题库格式错误：${(e as Error).message.slice(0, 300)}`);
  }
  const r = await upsertQuestions(items, { autoPublish: false, reviewer: u.email });
  return json(r);
});
