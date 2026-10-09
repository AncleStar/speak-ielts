"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, BookOpen, Check, EyeOff, FilePlus2, FlaskConical, Search, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/form";
import { ApiError, api } from "@/lib/client/api";
import { useNavigationGuard } from "@/lib/client/use-navigation-guard";
import { containsTerm, type ThoughtDetail, type ThoughtList, type ThoughtEdit } from "@/lib/thoughts/schema";
import { formatDateTime } from "@/lib/utils";
import { ThoughtPracticePanel } from "./practice-panel";
import { deleteThoughtDraft, isThoughtDeleted, listThoughtDrafts, removeThoughtDrafts, THOUGHT_DRAFT_SIGNAL } from "@/lib/client/idb";
import { useThoughtDraft } from "@/lib/client/use-thought-draft";
import { draftTitle, type ThoughtDraft } from "@/lib/thoughts/draft";

type Draft = Omit<ThoughtEdit, "revision">;
const empty: Draft = { sourceText: "", title: "", simple: "", natural: "", nuanced: "" };
function draftOf(t: ThoughtDetail | null): Draft { return t ? { sourceText: t.sourceText, title: t.title, simple: t.simple, natural: t.natural, nuanced: t.nuanced } : { ...empty }; }
export function ThoughtLab({ initial, selected, practiceInitially, modelLabel }: { initial: ThoughtList; selected: ThoughtDetail | null; practiceInitially: boolean; modelLabel: string }) {
  const [list, setList] = useState(initial), [current, setCurrent] = useState(selected), [draft, setDraft] = useState<Draft>(draftOf(selected));
  const [search, setSearch] = useState(""), [busy, setBusy] = useState(""), [message, setMessage] = useState(""), [error, setError] = useState("");
  const [practice, setPractice] = useState(practiceInitially && !!selected), [practiceBusy, setPracticeBusy] = useState(false), [selectedWords, setWords] = useState<number[]>([]);
  const [practiceUnsaved, setPracticeUnsaved] = useState(false);
  const [generation, setGeneration] = useState<{ sourceText: string; requestId: string } | null>(null);
  const [localDrafts, setLocalDrafts] = useState<ThoughtDraft[]>([]), [baseRevision, setBaseRevision] = useState<number | null>(selected?.revision ?? null);
  const [recallDraft, setRecallDraft] = useState<Extract<ThoughtDraft, { kind: "recall" }> | null>(null);
  const [deleted, setDeleted] = useState(false);
  const restoredEdit = useRef<ThoughtDraft | null>(null);
  const dirty = current ? JSON.stringify(draft) !== JSON.stringify(draftOf(current)) : !!draft.sourceText.trim();
  const editing = !!current && dirty;
  const blocked = !!busy || practiceBusy;
  const conflict = !!current && baseRevision !== current.revision;
  const editorDraft = useThoughtDraft({ kind: "edit", thoughtId: current?.id ?? null, revision: baseRevision, fields: draft, generation }, !deleted && !practice && (dirty || !!generation));
  async function refreshDrafts() { setLocalDrafts(await listThoughtDrafts()); }
  async function clearSavedEditDrafts() {
    for (const row of await listThoughtDrafts()) if (row.kind === "edit" && row.thoughtId === (current?.id ?? null) && JSON.stringify(row.fields) === JSON.stringify(draft)
      && (!row.generation || row.generation.requestId === generation?.requestId)) await deleteThoughtDraft(row.id, row);
  }
  useEffect(() => { void refreshDrafts(); }, [editorDraft.status]);
  useEffect(() => {
    let live = true;
    const changed = () => { void (async () => { const rows = await listThoughtDrafts(), removed = current ? await isThoughtDeleted(current.id) : false; if (live) { setLocalDrafts(rows); if (removed) { setDeleted(true); setPractice(false); } } })().catch(() => {}); };
    changed(); let channel: BroadcastChannel | undefined;
    try { channel = new BroadcastChannel(THOUGHT_DRAFT_SIGNAL); channel.onmessage = changed; } catch { /* focus checks remain available */ }
    const storage = (event: StorageEvent) => { if (event.key === THOUGHT_DRAFT_SIGNAL) changed(); };
    window.addEventListener("focus", changed); window.addEventListener("storage", storage); window.addEventListener(THOUGHT_DRAFT_SIGNAL, changed);
    return () => { live = false; channel?.close(); window.removeEventListener("focus", changed); window.removeEventListener("storage", storage); window.removeEventListener(THOUGHT_DRAFT_SIGNAL, changed); };
  }, [current?.id]);
  useNavigationGuard(!deleted && (dirty || !!busy || practiceBusy || practiceUnsaved), busy ? "当前操作还在进行，离开页面可能看不到结果。确定离开吗？" : "当前输入或练习尚未正式保存，确定离开吗？观点录音离开后无法恢复。");
  function updateDraft(field: keyof Draft, value: string) { setDraft(old => ({ ...old, [field]: value })); setMessage(""); }
  async function useThought(thought: ThoughtDetail | null) {
    await editorDraft.fork(); restoredEdit.current = null; setRecallDraft(null);
    setCurrent(thought); setDeleted(false); setBaseRevision(thought?.revision ?? null); setDraft(draftOf(thought)); setWords([]); setPractice(false); setGeneration(null);
    window.history.replaceState(window.history.state, "", thought ? `/thoughts?thought=${thought.id}` : "/thoughts");
    await refreshDrafts();
  }
  async function refreshList(offset = list.offset) { setList(await api<ThoughtList>(`/api/thoughts?q=${encodeURIComponent(search)}&offset=${offset}`)); }
  function canLeave() { return deleted || !(dirty || practiceUnsaved) || window.confirm("当前输入或练习尚未正式保存，确定切换吗？观点录音离开后无法恢复。"); }
  async function run(label: string, task: () => Promise<void>) { setBusy(label); setError(""); setMessage(""); try { await task(); } catch (e) { setError((e as Error).message); } finally { setBusy(""); } }
  async function open(id: string) { if (!canLeave()) return; await run("open", async () => { await useThought(await api<ThoughtDetail>(`/api/thoughts/${id}`)); }); }
  async function generate() {
    const payload = generation?.sourceText === draft.sourceText.trim() ? generation : { sourceText: draft.sourceText.trim(), requestId: crypto.randomUUID() };
    setGeneration(payload);
    await run("generate", async () => {
      try { const thought = await api<ThoughtDetail>("/api/thoughts", { body: payload, signal: AbortSignal.timeout(75_000) }); if (!current) { await editorDraft.clear(); await clearSavedEditDrafts(); if (restoredEdit.current) await deleteThoughtDraft(restoredEdit.current.id, restoredEdit.current); } await useThought(thought); setMessage("三种表达已生成，并自动保存到观点历史。"); await refreshList(0); }
      catch (e) { if (!(e instanceof ApiError) || !["network", "generation_pending"].includes(e.code)) setGeneration(null); throw e; }
    });
  }
  async function save() { if (!current) return; await run("save", async () => {
    const saved = await api<ThoughtDetail>(`/api/thoughts/${current.id}`, { method: "PUT", body: { ...draft, revision: baseRevision } });
    await editorDraft.clear(); if (restoredEdit.current) await deleteThoughtDraft(restoredEdit.current.id, restoredEdit.current);
    await clearSavedEditDrafts();
    await useThought(saved); setMessage("修改已保存。Natural 的变化会同步到复习卡片。"); await refreshList();
  }); }
  async function toggleReview() { if (!current) return; await run("review", async () => {
    const removing = !!current.review; const saved = await api<ThoughtDetail>(`/api/thoughts/${current.id}/review`, { body: { action: removing ? "remove" : "enroll", revision: current.revision } }); setCurrent(saved);
    setMessage(removing ? "已移出复习，历史练习记录仍保留。" : "Natural 已加入今日复习，后续按 1、3、7、14 天安排。");
  }); }
  async function saveWords() { if (!current) return; await run("words", async () => {
    const result = await api<{ added: number; existing: number }>("/api/vocabulary", { body: { thoughtId: current.id, revision: current.revision, indices: selectedWords } });
    setMessage(`已收藏 ${result.added} 个词语${result.existing ? `，${result.existing} 个已在词汇库中` : ""}。`); setWords([]);
  }); }
  async function remove() { if (!current || !window.confirm("删除这份观点及其练习、复习记录？已收藏的词语会保留。")) return;
    await run("delete", async () => { await api(`/api/thoughts/${current.id}`, { method: "DELETE" }); const cleaned = await removeThoughtDrafts(current.id); await editorDraft.clear(); await useThought(null); await refreshList(0); setMessage(cleaned ? "观点及其本机草稿已删除。" : "观点已删除。本机存储受限，请在浏览器设置中清除本站数据，确保旧草稿也已清理。"); }); }
  async function restore(row: ThoughtDraft) {
    if (!canLeave()) return;
    await run("restore", async () => {
      const target = row.thoughtId ? await api<ThoughtDetail>(`/api/thoughts/${row.thoughtId}`) : null;
      await useThought(target);
      if (row.kind === "edit") { restoredEdit.current = row; setDraft(row.fields); setBaseRevision(row.revision); setGeneration(row.generation); }
      else { setRecallDraft(row); setPractice(true); }
      setMessage("本机文本草稿已恢复，请检查后继续。录音不会从草稿恢复。");
    });
  }

  return <div className="thought-lab">
    <header className="thought-page-heading"><div><p className="eyebrow">PERSONAL THOUGHT LAB / 自由练习</p><h1 className="page-title">个人观点实验室<span>把想法，练成自己的表达。</span></h1><p>从一句中文或英文开始，整理观点，开口练习，留下可以再用的素材。</p></div><FlaskConical size={36} strokeWidth={1} aria-hidden /></header>
    <nav className="thought-subnav" aria-label="个人素材导航"><Link href="/thoughts" aria-current="page">01 / 观点实验室</Link><Link href="/vocabulary">02 / 个人词汇库 <ArrowUpRight size={13} /></Link><Link href="/review">03 / 今日复习 <ArrowUpRight size={13} /></Link></nav>
    <div className="thought-layout">
      <aside className="thought-history" aria-label="观点历史">
        <div className="thought-section-heading"><h2>观点历史 <small>{list.total}</small></h2><Button variant="ghost" size="sm" disabled={blocked} onClick={() => { if (canLeave()) void run("new", () => useThought(null)); }} aria-label="新建观点"><FilePlus2 size={18} /></Button></div>
        {!!localDrafts.length && <details className="thought-local-drafts" open><summary>本机草稿 · {localDrafts.length}</summary><p>保留 24 小时；退出或切换账号时清除。</p><ul>{localDrafts.map(row => <li key={row.id}><div><span>{draftTitle(row)}</span><small>{row.kind === "recall" ? "回想文本" : "观点编辑"} · {formatDateTime(new Date(row.savedAt).toISOString())}</small></div><div><button type="button" disabled={blocked} onClick={() => void restore(row)}>恢复草稿</button><button type="button" disabled={blocked} onClick={() => { if (confirm("丢弃这份本机草稿？")) void run("discard", async () => { await deleteThoughtDraft(row.id, row); await refreshDrafts(); }); }}>丢弃</button></div></li>)}</ul></details>}
        <form className="thought-search" onSubmit={e => { e.preventDefault(); void run("search", () => refreshList(0)); }}><Input aria-label="搜索观点" value={search} maxLength={100} onChange={e => setSearch(e.target.value)} placeholder="搜索观点…" /><button type="submit" aria-label="搜索观点历史" disabled={blocked}><Search size={16} /></button></form>
        <div className="thought-history-items">{list.items.map(item => <button type="button" key={item.id} disabled={blocked} onClick={() => void open(item.id)} aria-current={current?.id === item.id ? "true" : undefined}><span>{item.title}</span><p>{item.sourceText}</p><small>{formatDateTime(item.updatedAt)}{item.mock && " · 演示"}</small></button>)}</div>
        {!list.items.length && <p className="thought-note">{search ? "没有匹配的观点，试试其他关键词。" : "第一份表达，会从这里开始积累。"}</p>}
        {list.total > list.pageSize && <div className="thought-actions"><Button size="sm" variant="ghost" disabled={blocked || list.offset === 0} onClick={() => void run("search", () => refreshList(list.offset - list.pageSize))}>上一页</Button><span className="thought-note">{Math.floor(list.offset / list.pageSize) + 1} / {Math.ceil(list.total / list.pageSize)}</span><Button size="sm" variant="ghost" disabled={blocked || list.offset + list.pageSize >= list.total} onClick={() => void run("search", () => refreshList(list.offset + list.pageSize))}>下一页</Button></div>}
      </aside>
      <div className="thought-workbench" aria-busy={!!busy}>
        {error && <div role="alert" className="thought-notice is-error">{error}{current && <button onClick={() => { if (canLeave()) void run("open", async () => useThought(await api<ThoughtDetail>(`/api/thoughts/${current.id}`))); }} disabled={blocked}>重新打开已保存版本</button>}</div>}
        {message && <p role="status" className="thought-notice"><Check size={16} />{message}</p>}
        {!practice && editorDraft.status && <p role="status" className="thought-draft-status">{editorDraft.status}</p>}
        {conflict && !practice && !deleted && <div role="alert" className="thought-notice is-error">已保存版本有更新。草稿仍保留，不能直接覆盖。<details><summary>查看最新保存内容</summary><p>{current?.sourceText}</p><p lang="en">{current?.simple}</p><p lang="en">{current?.natural}</p><p lang="en">{current?.nuanced}</p></details><Button variant="outline" onClick={() => { if (confirm("已核对最新保存内容？接下来保存会用当前草稿替换该版本，请先手动合并需要保留的表达。")) setBaseRevision(current!.revision); }}>我已核对，使用草稿继续编辑</Button></div>}
        {deleted ? <section className="thought-notice" role="status"><p>这份观点已在其他页面删除，相关本机草稿已清除。</p><Button variant="outline" disabled={blocked} onClick={() => void run("new", () => useThought(null))}>新建观点</Button></section> : practice && current ? <ThoughtPracticePanel key={`${current.id}-${current.revision}-${recallDraft?.id ?? "fresh"}`} thought={current} initialDraft={recallDraft} onBusy={setPracticeBusy} onUnsavedChange={setPracticeUnsaved} onClose={() => { if (canLeave()) { setPractice(false); setRecallDraft(null); void refreshDrafts(); } }} onSaved={saved => { setCurrent(saved); setPractice(false); setRecallDraft(null); void refreshDrafts(); setMessage("练习已保存，可在本页查看复习时间与练习记录。"); }} /> : <>
          <section className="thought-source-panel"><div className="thought-section-heading"><h2><span>01</span> 你的原始观点</h2><small>中文 / ENGLISH</small></div>
            <Label htmlFor="thought-source" className="sr-only">原始观点（中文或英文）</Label><Textarea id="thought-source" value={draft.sourceText} disabled={blocked} onChange={e => updateDraft("sourceText", e.target.value)} maxLength={2000} rows={4} placeholder="例如：我认为大学生应该多参加社会实践，因为这能帮助他们把课堂知识用到真实生活中。" />
            <div className="thought-source-footer"><span>{draft.sourceText.length} / 2000</span><Button onClick={() => void generate()} disabled={blocked || draft.sourceText.trim().length < 3}><Sparkles size={15} />{busy === "generate" ? "正在整理三种表达…" : current ? "重新生成并存为新观点" : "生成三种表达"}</Button></div>
            <div className="thought-provider"><span>{modelLabel} · 生成会将此观点发送给所选模型，并计入当前预算</span><Link href="/settings/ai">API Key、模型与用量 <ArrowUpRight size={12} /></Link></div>
          </section>
          {!current ? <section className="thought-empty"><BookOpen size={30} strokeWidth={1} /><h2>同一个观点，找到三种表达。</h2><p>Simple 说清意思，Natural 让表达更自然，Nuanced 补充层次与取舍。生成后可继续改写。</p><div>{[["01", "Simple", "简单直接"], ["02", "Natural", "自然口语"], ["03", "Nuanced", "有层次的表达"]].map(([n, label, caption]) => <span key={n}><small>{n}</small><strong>{label}</strong><em>{caption}</em></span>)}</div><Button variant="ghost" disabled={blocked} onClick={() => updateDraft("sourceText", "我认为大学生应该多参加社会实践，因为这能帮助他们把课堂知识用到真实生活中。")}>试用一个示例观点 →</Button></section> : <>
            <section className="thought-result-header"><div className="thought-section-heading"><h2><span>02</span> 三种表达</h2><span className="thought-result-meta">{current.mock ? "模拟演示" : current.model}{current.edited && " · 已手动修改"}</span></div>
              {current.mock && <p className="thought-notice">当前结果是固定演示示例，不是对输入的分析或翻译。可在 API 与用量中配置真实服务。</p>}
              <Label htmlFor="thought-title">观点标题</Label><Input id="thought-title" value={draft.title} disabled={blocked} maxLength={80} onChange={e => updateDraft("title", e.target.value)} />
              <details className="thought-analysis"><summary>查看生成时的观点分析</summary><p>{current.analysis}</p>{current.edited && <small>分析对应生成时的输入；重新生成可获得与新观点匹配的分析。</small>}</details>
            </section>
            <div className="thought-expressions">{([['simple', 'Simple', '简单表达', '01'], ['natural', 'Natural', '自然表达', '02'], ['nuanced', 'Nuanced', '有深度的表达', '03']] as const).map(([field, label, caption, n]) => <section className={`thought-expression is-${field}`} key={field}><div><small>{n} / EXPRESSION</small><h3><label htmlFor={`thought-${field}`}>{label}<span>{caption}</span></label></h3></div><Textarea id={`thought-${field}`} lang="en" value={draft[field]} onChange={e => updateDraft(field, e.target.value)} maxLength={field === "simple" ? 1200 : field === "natural" ? 2000 : 2800} disabled={blocked} rows={10} /><p>{draft[field].trim().split(/\s+/).filter(Boolean).length} words · 可直接编辑</p></section>)}</div>
            <div className="thought-actions thought-result-actions"><Button disabled={blocked || !editing || conflict} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存修改"}</Button><Button variant="outline" disabled={blocked || editing || conflict} onClick={() => { setPractice(true); setRecallDraft(null); setError(""); setMessage(""); }}><EyeOff size={15} />隐藏 Natural，开始练习</Button><Button variant="secondary" disabled={blocked || editing || conflict} onClick={() => void toggleReview()}>{current.review ? "移出 Natural 复习" : "将 Natural 加入复习"}</Button>{editing && <p className="thought-note">先保存修改，再练习或收藏。</p>}</div>
            {current.review && <p className="thought-review-status">下次复习：{formatDateTime(current.review.nextDueAt)} · 已连续回想 {current.review.completedCount} 次 <Link href="/review">查看复习安排 ↗</Link></p>}
            <section className="thought-vocabulary"><div className="thought-section-heading"><h2><span>03</span> 从表达中收藏词语</h2><Link href="/vocabulary">我的词汇库 ↗</Link></div>
              {current.vocabulary.length ? <ul>{current.vocabulary.map((word, index) => { const present = containsTerm([draft.simple, draft.natural, draft.nuanced].join("\n"), word.term); return <li key={index}><label><input type="checkbox" checked={selectedWords.includes(index)} disabled={blocked || editing || !present} onChange={e => setWords(old => e.target.checked ? [...old, index] : old.filter(i => i !== index))} /><span><strong lang="en">{word.term}</strong><span>{word.meaning}</span><p lang="en">{word.example}</p>{!present && <small>词语已不在当前表达中</small>}</span></label></li>; })}</ul> : <p className="thought-note">这次生成没有提供与表达匹配的词语。</p>}
              <Button variant="outline" disabled={blocked || editing || !selectedWords.length} onClick={() => void saveWords()}>收藏选中的 {selectedWords.length} 个词语</Button>
            </section>
            <section className="thought-practice-history"><div className="thought-section-heading"><h2><span>04</span> 最近练习与复习</h2><small>最近 20 次</small></div>{current.practices.length ? <ul>{current.practices.map(p => <li key={p.id}><div><strong>{p.outcome === "remembered" ? "已想起来" : p.outcome === "again" ? "还想再练" : "自由练习"}</strong><small>{formatDateTime(p.createdAt)} · 录音 {Math.round(p.durationSeconds)} 秒</small></div>{p.recalledText && <p lang="en">{p.recalledText}</p>}<details><summary>当时的 Natural 表达</summary><p lang="en">{p.naturalText}</p></details></li>)}</ul> : <p className="thought-note">隐藏 Natural 练习一次，记录会保存在这里。</p>}</section>
            <footer className="thought-document-footer"><span>保存于 {formatDateTime(current.updatedAt)} · 仅本人可访问</span><button type="button" disabled={blocked} onClick={() => void remove()}><Trash2 size={14} />删除观点</button></footer>
          </>}
        </>}
      </div>
    </div>
  </div>;
}
