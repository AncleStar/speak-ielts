"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import { setPublishedAction } from "@/app/actions/admin";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";

export function PublishToggle({ versionId, published }: { versionId: string; published: boolean }) {
  const [state, action, pending] = useActionState(setPublishedAction, null);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="published" value={published ? "false" : "true"} />
      <Button type="submit" size="sm" variant={published ? "danger-outline" : "primary"} disabled={pending}>
        {published ? "取消发布" : "发布此版本"}
      </Button>
      {state?.error ? <span className="text-xs text-red-700">{state.error}</span> : null}
      {state?.ok ? <span className="text-xs text-emerald-700">{state.ok}</span> : null}
    </form>
  );
}

export function ImportForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted">
        支持与 content/ielts/part1.json、part2.json、part3.json 相同的结构，或标准化题目数组。变化的题目会生成新版本，默认不发布，需要审核后再发布。
      </p>
      <input type="file" accept="application/json,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm" />
      <Button
        size="sm"
        disabled={!file || busy}
        onClick={async () => {
          if (!file) return;
          setBusy(true);
          setMsg(null);
          try {
            const res = await fetch("/api/admin/import", { method: "POST", body: await file.text(), headers: { "Content-Type": "application/json" } });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error?.message ?? "导入失败");
            setMsg({ tone: "success", text: `导入完成：新建 ${data.created}，新版本 ${data.updated}，未变 ${data.unchanged}${data.errors?.length ? `；错误 ${data.errors.length} 条：${data.errors.slice(0, 3).join("；")}` : ""}` });
            router.refresh();
          } catch (e) {
            setMsg({ tone: "danger", text: (e as Error).message });
          }
          setBusy(false);
        }}
      >
        {busy ? "正在导入…" : "导入"}
      </Button>
      {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
    </div>
  );
}
