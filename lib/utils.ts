import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "—";
  const s = Math.round(sec);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} 分 ${r} 秒` : `${m} 分钟`;
}

export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric" }).format(date);
}

export const MODE_LABEL: Record<string, string> = {
  level: "闯关训练",
  mock: "完整模考",
  practice: "自由练习",
  retry: "重练",
};

export const SESSION_STATUS_LABEL: Record<string, string> = {
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  interrupted: "中断",
  abandoned: "已放弃",
};

export const ANSWER_STATUS_LABEL: Record<string, string> = {
  created: "等待上传",
  uploaded: "已上传",
  queued: "排队处理中",
  processing: "处理中",
  done: "反馈已生成",
  insufficient: "无法充分评价",
  failed: "处理失败",
};

export const INSUFFICIENT_LABEL: Record<string, string> = {
  no_audio: "没有检测到录音内容",
  too_short: "有效语音少于 3 秒",
  too_few_words: "识别到的内容少于 8 个词",
};
