"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client/api";

export function DeleteSessionButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy}
      aria-label="删除"
      data-testid={`delete-${id}`}
      onClick={async () => {
        if (!confirm("删除本次练习？录音、转写和反馈将一并删除，且无法恢复。")) return;
        setBusy(true);
        try {
          await api(`/api/sessions/${id}`, { method: "DELETE" });
          router.refresh();
        } catch {
          alert("删除失败，请重试");
          setBusy(false);
        }
      }}
    >
      <Trash2 className="h-4 w-4 text-red-600" />
    </Button>
  );
}
