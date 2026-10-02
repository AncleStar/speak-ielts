import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap", {
  variants: {
    tone: {
      default: "bg-slate-100 text-slate-700",
      brand: "bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200",
      success: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200",
      warning: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200",
      danger: "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200",
      muted: "bg-slate-50 text-slate-500 ring-1 ring-inset ring-slate-200",
    },
  },
  defaultVariants: { tone: "default" },
});

export function Badge({ className, tone, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export function DraftBadge({ className }: { className?: string }) {
  return (
    <Badge tone="warning" className={className} title="题目与参考回答由 AI 起草，尚未经过人工审核">
      AI 草稿·未人工审核
    </Badge>
  );
}
