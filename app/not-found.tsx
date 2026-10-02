import { LinkButton } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-5xl font-semibold text-brand-600">404</p>
      <p className="text-muted">页面不存在，或你没有访问权限。</p>
      <LinkButton href="/">返回首页</LinkButton>
    </main>
  );
}
