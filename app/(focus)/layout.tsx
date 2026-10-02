import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { requireUser } from "@/lib/auth-server";
import { SpeakBrand } from "@/components/nav";

export default async function FocusLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return (
    <div className="min-h-dvh">
      <header className="terminal-header focus-header">
        <SpeakBrand />
        <p className="terminal-kicker">PLAY / RECORD <span>英语口语训练终端</span></p>
      </header>
      {children}
    </div>
  );
}
