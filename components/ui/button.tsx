import { cva, type VariantProps } from "class-variance-authority";
import Link from "next/link";
import * as React from "react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 select-none",
  {
    variants: {
      variant: {
        primary: "bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 shadow-sm",
        secondary: "bg-brand-50 text-brand-700 hover:bg-brand-100 border border-brand-200",
        outline: "border border-line bg-white text-ink hover:bg-slate-50",
        ghost: "text-ink hover:bg-slate-100",
        danger: "bg-red-600 text-white hover:bg-red-700",
        "danger-outline": "border border-red-200 text-red-700 bg-white hover:bg-red-50",
      },
      size: {
        sm: "h-9 px-3 text-sm min-w-9",
        md: "h-11 px-4 text-[15px] min-w-11",
        lg: "h-14 px-6 text-base min-w-14",
        icon: "h-11 w-11",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, type, ...props }, ref) => (
  <button ref={ref} type={type ?? "button"} className={cn(buttonVariants({ variant, size }), className)} {...props} />
));
Button.displayName = "Button";

export function LinkButton({
  href,
  className,
  variant,
  size,
  children,
  prefetch,
  ...rest
}: { href: string; className?: string; children: React.ReactNode; prefetch?: boolean; "data-testid"?: string; title?: string } & VariantProps<typeof buttonVariants>) {
  return (
    <Link href={href} prefetch={prefetch} className={cn(buttonVariants({ variant, size }), className)} {...rest}>
      {children}
    </Link>
  );
}
