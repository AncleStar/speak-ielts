"use client";

/** 面试期间请求屏幕常亮；不支持时由界面提示关闭自动锁屏 */
export class ScreenWakeLock {
  private sentinel: { release: () => Promise<void> } | null = null;
  private wanted = false;
  readonly supported = typeof navigator !== "undefined" && "wakeLock" in navigator;

  private onVisible = () => {
    if (this.wanted && document.visibilityState === "visible") void this.acquire();
  };

  async request(): Promise<boolean> {
    this.wanted = true;
    document.addEventListener("visibilitychange", this.onVisible);
    return this.acquire();
  }

  private async acquire(): Promise<boolean> {
    if (!this.supported) return false;
    try {
      this.sentinel = await (navigator as unknown as { wakeLock: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock.request("screen");
      return true;
    } catch {
      return false;
    }
  }

  async release() {
    this.wanted = false;
    document.removeEventListener("visibilitychange", this.onVisible);
    try {
      await this.sentinel?.release();
    } catch {
      /* ignore */
    }
    this.sentinel = null;
  }
}
