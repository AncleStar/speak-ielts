import { TerminalAuthShell } from "@/components/auth/terminal-auth-shell";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <TerminalAuthShell>{children}</TerminalAuthShell>;
}
