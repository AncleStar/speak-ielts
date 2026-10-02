import Link from "next/link";
import { BottomNav, TopNav } from "@/components/nav";
import { requireAdmin } from "@/lib/auth-server";

const TABS = [
  { href: "/admin", label: "服务状态" },
  { href: "/admin/users", label: "账号" },
  { href: "/admin/invites", label: "邀请码" },
  { href: "/admin/questions", label: "题库审核" },
  { href: "/admin/tts", label: "考官音频" },
  { href: "/admin/usage", label: "用量与预算" },
  { href: "/admin/rewards", label: "积分与兑换" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const u = await requireAdmin();
  return (
    <>
      <TopNav isAdmin name={u.name} />
      <main className="mx-auto w-full max-w-6xl px-4 pb-24 pt-5 md:pb-12">
        <nav className="mb-5 flex flex-wrap gap-1.5" aria-label="管理导航">
          {TABS.map((t) => (
            <Link key={t.href} href={t.href} className="rounded-lg bg-white px-3 py-1.5 text-sm ring-1 ring-line hover:bg-slate-50">
              {t.label}
            </Link>
          ))}
        </nav>
        {children}
      </main>
      <BottomNav />
    </>
  );
}
