"use client";
import { useState } from "react";
import { KeyRound, BarChart3, RefreshCw } from "lucide-react";
import { api } from "@/lib/client/api";
import { AI_CATALOG } from "@/lib/ai/catalog";
import type { AiAccountView } from "@/lib/ai/account";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Checkbox } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";

const money = (n: number) => `¥${n.toFixed(6)}`;
const services: Record<string,string> = { asr: "语音识别", llm: "反馈 / 追问", tts: "语音合成", omni: "音频诊断" };
function unitText(units: Record<string,unknown>) {
  if ("seconds" in units) return `${Number(units.seconds).toLocaleString()} 秒`;
  if ("chars" in units) return `${Number(units.chars).toLocaleString()} 字符`;
  return `输入 ${Number(units.inputTokens ?? 0).toLocaleString()} / 输出 ${Number(units.outputTokens ?? 0).toLocaleString()} Token`;
}
export function ApiSettings({ initial }: { initial: AiAccountView }) {
  const [view, setView] = useState(initial), [mode, setMode] = useState(initial.config.mode);
  const [key, setKey] = useState(""), [asr, setAsr] = useState(initial.config.asrModel), [llm, setLlm] = useState(initial.config.llmModel);
  const [budget, setBudget] = useState(String(initial.config.monthlyBudgetYuan)), [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [month, setMonth] = useState(initial.month);
  const selected = AI_CATALOG.llm.find(m => m.id === llm)!;
  const personal = view.totals.find(t => t.source === "personal"), platform = view.totals.find(t => t.source === "platform");
  async function reload(offset = 0, nextMonth = month) { setView(await api<AiAccountView>(`/api/ai-settings?month=${encodeURIComponent(nextMonth)}&offset=${offset}`)); }
  async function run(fn: () => Promise<void>) {
    if (busy) return; setBusy(true); setError(""); setMessage("");
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "操作失败，请重试。"); } finally { setBusy(false); }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault(); await run(async () => {
      await api("/api/ai-settings", { method: "PUT", body: { mode, apiKey: key, asrModel: asr, llmModel: llm, monthlyBudgetYuan: Number(budget), consent } });
      setKey(""); setConsent(false); await reload(); setMessage("设置已保存，将用于后续模型调用。正在执行的请求仍使用原配置。");
    });
  }
  return <div className="ai-account" data-testid="ai-account">
    <div className="ai-account-heading"><span><KeyRound size={15}/> PERSONAL ACCESS</span><span>{view.config.mode === "personal" ? view.config.hasKey ? "个人 Key 已启用" : "个人服务等待密钥" : "使用站点服务"}</span></div>
    {error && <Alert tone="danger">{error}</Alert>}{message && <Alert tone="success">{message}</Alert>}
    <div className="ai-account-grid">
      <form onSubmit={save} className="ai-account-panel">
        <p className="terminal-kicker">01 / 服务配置</p><h2>你的 API Key</h2>
        <Field label="服务模式" htmlFor="ai-mode"><Select id="ai-mode" value={mode} onChange={e => setMode(e.target.value as typeof mode)} disabled={busy}><option value="platform">使用站点服务</option><option value="personal">使用自己的 API Key</option></Select></Field>
        {mode === "platform" ? <p className="ai-explanation">当前站点{view.platform.mock ? "默认提供模拟转写和反馈" : `使用 ${view.platform.asrModel} 转写、${view.platform.llmModel} 反馈`}。开启个人模式后，转写和反馈从你的百炼账户计费。</p> : <>
          <p className="ai-explanation">{AI_CATALOG.provider}。请使用该地域的按量付费 API Key。</p>
          <Field label="百炼 API Key" htmlFor="personal-api-key" hint={view.config.maskedKey ? `已保存 ${view.config.maskedKey}，留空保留原密钥。` : "保存后只显示尾号，可随时替换或删除。"}><Input id="personal-api-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} placeholder="粘贴你的百炼 API Key" maxLength={512} disabled={busy}/></Field>
          <div className="ai-fields"><Field label="语音识别模型" htmlFor="ai-asr"><Select id="ai-asr" value={asr} onChange={e => setAsr(e.target.value)} disabled={busy}>{AI_CATALOG.asr.map(m => <option value={m.id} key={m.id}>{m.label}</option>)}</Select></Field><Field label="反馈与追问模型" htmlFor="ai-llm"><Select id="ai-llm" value={llm} onChange={e => setLlm(e.target.value)} disabled={busy}>{AI_CATALOG.llm.map(m => <option value={m.id} key={m.id}>{m.label}</option>)}</Select></Field></div>
          <Field label="个人月度预算（元）" htmlFor="ai-budget" hint="这是本应用内的调用上限，不是百炼余额。设为 0 暂停个人付费调用。"><Input id="ai-budget" type="number" min="0" max="10000" step="0.01" required value={budget} onChange={e => setBudget(e.target.value)} disabled={busy}/></Field>
          <Checkbox checked={consent} onChange={e => setConsent(e.target.checked)} required disabled={busy} label="我同意将录音与回答发送至阿里云百炼处理，并由我的 API 账户承担费用。密钥由本站服务端加密保存；请只在自己部署或信任的站点填写。"/>
        </>}
        <div className="ai-actions"><Button type="submit" disabled={busy}>保存设置</Button>{view.config.hasKey && <Button type="button" variant="danger-outline" disabled={busy} onClick={() => run(async () => { await api("/api/ai-settings", { method: "DELETE" }); setKey(""); await reload(); setMessage("个人密钥已删除。个人模式保持暂停，切换站点服务需另行保存。"); })}>删除密钥</Button>}</div>
        {view.config.mode === "personal" && view.config.hasKey && <Button type="button" variant="outline" disabled={busy || key.length > 0 || llm !== view.config.llmModel || mode !== view.config.mode} onClick={() => run(async () => { try { const result = await api<{message:string}>("/api/ai-settings/test", { method: "POST" }); setMessage(result.message); } finally { await reload(); } })}>测试已保存的反馈模型（少量计费）</Button>}
        <p className="ai-explanation">考官语音仍由站点提供{view.platform.tts === "local" ? "，本地 Emma 语音不产生云 API 费用" : ""}。个人 Key 用于语音识别、反馈和追问；个人模式不调用实验性音频诊断。每日训练分钟、积分与并发限制继续生效。</p>
      </form>
      <aside className="ai-account-panel ai-cost-panel"><p className="terminal-kicker">02 / 费用与额度</p><h2>每一笔，都有记录</h2>
        <div className="ai-budget-value">{money(view.personalMonthCost)}<span>本月个人调用估算 / ¥{view.config.monthlyBudgetYuan}</span></div>
        <div className="ai-budget-track"><i style={{width:`${Math.min(100, view.config.monthlyBudgetYuan > 0 ? view.personalMonthCost / view.config.monthlyBudgetYuan * 100 : 100)}%`}}/></div>
        <p className="ai-explanation">本月预算剩余约 {money(Math.max(0, view.config.monthlyBudgetYuan-view.personalMonthCost))}。按北京时间自然月累计，只统计经本应用发起的调用。</p>
        <dl className="ai-price-list"><div><dt>语音识别</dt><dd>¥0.00022 / 秒</dd></div><div><dt>{selected.id} 输入</dt><dd>¥{selected.inputPerMillion} / 百万 Token</dd></div><div><dt>{selected.id} 输出</dt><dd>¥{selected.outputPerMillion} / 百万 Token</dd></div><div><dt>今日可用训练时间</dt><dd>{(view.quota.remainingSeconds/60).toFixed(1)} 分钟</dd></div><div><dt>正在预留的训练时间</dt><dd>{((view.quota.reservedSeconds ?? 0)/60).toFixed(1)} 分钟</dd></div></dl>
        <p className="ai-explanation">以上单价为北京地域非思考模式、输入不超过 128K Token 的原价，较长输入按阶梯估算。优惠、免费额度、缓存折扣及账户其他调用未计入；最终扣费以百炼账单为准。</p>
        <p className="ai-explanation">超时或调用失败的计费结果可能不明，会保留估算金额；“处理中”包含预留用量。删除密钥不清除已发生的消费。</p>
        <div className="ai-source-links"><a href={AI_CATALOG.sources.asr} target="_blank" rel="noreferrer">ASR 单价</a><a href={llm === "qwen-plus" ? AI_CATALOG.sources.plus : AI_CATALOG.sources.flash} target="_blank" rel="noreferrer">反馈模型单价</a><span>核对于 {AI_CATALOG.priceDate}</span></div>
      </aside>
    </div>
    <section className="ai-account-panel"><div className="ai-usage-heading"><div><p className="terminal-kicker">03 / 调用明细</p><h2><BarChart3 size={21}/> 用量账本</h2></div><div className="ai-actions"><Input type="month" aria-label="用量月份" value={month} onChange={e => setMonth(e.target.value)} min="2000-01" max="2099-12"/><Button variant="outline" disabled={busy || !month} onClick={() => run(() => reload())}><RefreshCw size={15}/>查询</Button></div></div>
      <div className="ai-usage-totals"><span>所选月个人估算 <b>{money(personal?.cost ?? 0)}</b></span><span>站点承担估算 <b>{money(platform?.cost ?? 0)}</b></span><span>共 <b>{view.totals.reduce((n,t) => n+t.calls,0)}</b> 次调用</span></div>
      <p className="ai-explanation">当前展示 {view.month}，仅包含你的调用；公共题目语音缓存的站点开销不分摊到个人明细。</p>
      {view.rows.length === 0 ? <p className="ai-empty">该月还没有调用记录。完成一次练习或测试连接后，可在这里查看。</p> : <div className="ai-usage-table" tabIndex={0} aria-label="可横向滚动的调用明细"><table><thead><tr><th>时间 / 模型</th><th>服务 / 计费来源</th><th>用量</th><th>估算费用</th><th>状态</th></tr></thead><tbody>{view.rows.map(row => <tr key={row.id}><td>{new Date(row.createdAt).toLocaleString("zh-CN", {timeZone:"Asia/Shanghai",hour12:false})}<small>{row.model}</small></td><td>{services[row.service] ?? row.service}<small>{row.source === "personal" ? "个人 Key" : "站点服务"}{row.mock ? " · 模拟" : ""}</small></td><td>{unitText(row.units)}<small>{row.units.estimated ? "预留 / 估算用量" : "服务返回用量"}</small></td><td>{money(row.cost)}</td><td>{row.units.pending ? "处理中" : row.ok ? "成功" : "失败 · 待对账"}</td></tr>)}</tbody></table></div>}
      <div className="ai-pagination"><Button variant="outline" disabled={busy || view.offset === 0} onClick={() => run(() => reload(Math.max(0,view.offset-30),view.month))}>上一页</Button><span>第 {view.offset/30+1} 页</span><Button variant="outline" disabled={busy || !view.hasMore} onClick={() => run(() => reload(view.offset+30,view.month))}>下一页</Button></div>
    </section>
  </div>;
}
