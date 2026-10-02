"use client";

import { computeClockOffset } from "@/lib/timing";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

/** 服务器时钟偏移：以往返时间最短的一次采样为准 */
let offsetMs = 0;
let bestRtt = Number.POSITIVE_INFINITY;

export function clockOffset() {
  return offsetMs;
}

/** 校正后的"服务器当前时间" */
export function serverNow() {
  return Date.now() + offsetMs;
}

export function noteServerTime(serverTime: number, sent: number, received: number) {
  const rtt = received - sent;
  if (!Number.isFinite(serverTime) || serverTime <= 0) return;
  // 最近的采样可能更准确（本机时钟可能漂移），RTT 相近时也更新
  if (rtt <= bestRtt * 1.5 || rtt < 300) {
    offsetMs = computeClockOffset(serverTime, sent, received);
    bestRtt = Math.min(bestRtt, rtt);
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; keepalive?: boolean } = {}): Promise<T> {
  const sent = Date.now();
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
      signal: init.signal ?? AbortSignal.timeout(30000),
      keepalive: init.keepalive,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "network", "网络连接失败，请检查网络后重试");
  }
  const received = Date.now();
  const st = Number(res.headers.get("X-Server-Time"));
  if (st) noteServerTime(st, sent, received);
  const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!res.ok) {
    if (res.status === 401) {
      throw new ApiError(401, "unauthorized", "登录已失效，请重新登录", data);
    }
    throw new ApiError(res.status, data?.error?.code ?? "error", data?.error?.message ?? `请求失败（${res.status}）`, data);
  }
  return data as T;
}

export function randomId(prefix = "") {
  const c = globalThis.crypto;
  if (c?.randomUUID) return prefix + c.randomUUID().replace(/-/g, "");
  return prefix + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
