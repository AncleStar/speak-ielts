import { BottomNav, TopNav } from "@/components/nav";
import { requireUser } from "@/lib/auth-server";
import { AmbientBackground } from "@/components/ambient-background";

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const u = await requireUser();
  return (
    <div className="relative isolate min-h-dvh">
      <AmbientBackground />
      <TopNav isAdmin={u.isAdmin} name={u.name} />
      <main className="terminal-main">{children}</main>
      <BottomNav />
    </div>
  );
}
