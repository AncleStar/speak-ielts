"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { ApiError, api } from "@/lib/client/api";
import { useRhine } from "@/components/disc/rhine-provider";

export interface StartInput {
  mode: "level" | "mock" | "practice" | "retry";
  levelId?: string;
  mockSetId?: string;
  questionId?: string;
  sourceAnswerId?: string;
  fresh?: boolean;
}

export function StartSessionButton({
  input,
  children,
  variant,
  size,
  className,
  confirmText,
  testId,
  disabled = false,
  cinematic = false,
  onPendingChange,
}: {
  input: StartInput;
  children: React.ReactNode;
  confirmText?: string;
  testId?: string;
  cinematic?: boolean;
  onPendingChange?: (pending: boolean) => void;
} & Pick<ButtonProps, "variant" | "size" | "className" | "disabled">) {
  const router = useRouter();
  const rhine = useRhine();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; code: string } | null>(null);

  async function start() {
    if (disabled || pending) return;
    if (confirmText && !confirm(confirmText)) return;
    setPending(true);
    onPendingChange?.(true);
    setError(null);
    try {
      const r = await api<{ id: string }>("/api/sessions", { body: input });
      router.prefetch(`/interview/${r.id}`);
      if (cinematic) await rhine?.enter();
      router.push(`/interview/${r.id}`);
    } catch (e) {
      setPending(false);
      onPendingChange?.(false);
      if (cinematic) rhine?.cancel();
      setError(e instanceof ApiError ? { message: e.message, code: e.code } : { message: "创建练习失败", code: "error" });
    }
  }

  return (
    <div className="space-y-2">
      <Button onClick={start} disabled={pending || disabled} variant={variant} size={size} className={className} data-testid={testId}>
        {pending ? "正在准备…" : children}
      </Button>
      {error ? (
        <Alert tone={error.code === "quota_exceeded" || error.code === "content_not_ready" ? "warning" : "danger"}>
          {error.message}
          {error.code === "consent_required" ? (
            <>
              {" "}
              <a href="/onboarding" className="underline">
                前往入门设置
              </a>
            </>
          ) : null}
        </Alert>
      ) : null}
    </div>
  );
}
