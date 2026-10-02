"use client";

import { Button } from "@/components/ui/button";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-lg font-semibold">页面出错了</p>
      <p className="text-sm text-muted">已保存的录音与记录不会丢失。请重试，或返回首页。</p>
      <div className="flex gap-2">
        <Button onClick={reset}>重试</Button>
        <Button variant="outline" onClick={() => (window.location.href = "/")}>
          返回首页
        </Button>
      </div>
    </main>
  );
}
