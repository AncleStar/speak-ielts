export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto w-full max-w-2xl px-4 py-8">{children}</main>;
}
