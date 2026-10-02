"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
export function ProcessingRefresh({ pending }: { pending: boolean }) {
  const router = useRouter();
  useEffect(() => { if (!pending) return; const timer = setInterval(() => { if (document.visibilityState === "visible" && navigator.onLine) router.refresh(); }, 6000); return () => clearInterval(timer); }, [pending, router]);
  return null;
}
