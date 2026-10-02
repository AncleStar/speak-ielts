import { Mic, Headphones, MessageCircle } from "lucide-react";
import { StartSessionButton } from "@/components/start-session-button";
import { LinkButton } from "@/components/ui/button";
import { requireUser } from "@/lib/auth-server";
import { providers } from "@/lib/providers";
export default async function WelcomePage() {
  await requireUser();
  return <div className="mx-auto max-w-3xl space-y-7 py-6"><section className="hero-panel p-7 sm:p-10"><p className="eyebrow">YOUR FIRST CONVERSATION</p><h1 className="mt-4 text-3xl font-semibold leading-snug">先用三分钟，<br />熟悉一次口语练习。</h1><p className="mt-5 text-sm leading-7 text-muted">不用准备漂亮的答案。我们从「你住在哪里」开始，说清楚自己的真实生活就好。</p>
    <ol className="my-7 grid gap-5 sm:grid-cols-3">{[[Headphones,"听 Emma 提问","调好音量，听清问题。"],[Mic,"开口 30–45 秒","说地点，再补充一个细节。"],[MessageCircle,"回听与复盘","核对转写，选一个目标再练。"]].map(([Icon,title,note],i) => { const I = Icon as typeof Mic; return <li key={i}><I size={22} className="text-brand-700" /><h2 className="mt-3 text-sm font-semibold">{i+1}. {String(title)}</h2><p className="mt-2 text-xs leading-6 text-muted">{String(note)}</p></li>; })}</ol>
    <StartSessionButton input={{ mode: "practice", questionId: "P1-HOME-1" }} testId="start-first-practice">开始我的第一题</StartSessionButton><p className="mt-3 text-xs text-muted">体验包含一道题，录音计入正常额度；反馈耗时取决于服务响应。</p>
  </section>{providers().name === "mock" && <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">当前转写与反馈为演示模式，录音和考官声音可正常体验。接通真实服务后，新录音才会生成真实识别结果。</p>}
    <div className="flex flex-wrap gap-3"><LinkButton href="/" variant="outline">先逛逛首页</LinkButton><LinkButton href="/device-check?next=/welcome" variant="ghost">重新检查麦克风</LinkButton></div>
  </div>;
}
