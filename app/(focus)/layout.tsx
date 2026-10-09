import { requireUser } from "@/lib/auth-server";
import { SpeakBrand } from "@/components/nav";
import { PrivateSessionBoundary } from "@/components/account/private-session-boundary";

export default async function FocusLayout({ children }: { children: React.ReactNode }) {
  const u = await requireUser();
  return (
    <PrivateSessionBoundary userId={u.id}>
    <div className="min-h-dvh">
      <header className="terminal-header focus-header">
        <SpeakBrand />
        <p className="terminal-kicker">PLAY / RECORD <span>英语口语训练终端</span></p>
      </header>
      {children}
    </div>
    </PrivateSessionBoundary>
  );
}
