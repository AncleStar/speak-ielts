import Link from "next/link";
export const dynamic = "force-dynamic";
export const metadata = { title: "资料恢复检查" };

export default function Maintenance() {
  return <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-6 py-16">
    <p className="terminal-kicker">SPEAK TRAINING / SYSTEM CHECK</p>
    <h1 className="text-3xl font-semibold">资料恢复检查中</h1>
    <p className="text-muted">暂时无法登录或开始训练。部署者正在核对资料与账号，完成检查后即可继续使用。</p>
    <p className="text-sm text-muted">如果长时间没有恢复，请联系站点部署者。</p>
    <Link href="/login" className="terminal-action w-fit">检查是否已经恢复 →</Link>
  </main>;
}
