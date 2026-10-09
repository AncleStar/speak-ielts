"use client";
import Link from "next/link";
import { useState } from "react";
import { BookOpen, Pencil, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/form";
import { api } from "@/lib/client/api";
import type { VocabularyList, VocabularyView } from "@/lib/thoughts/schema";
import { formatDateTime } from "@/lib/utils";

export function VocabularyBank({ initial }: { initial: VocabularyList }) {
  const [list, setList] = useState(initial), [query, setQuery] = useState(""), [editing, setEditing] = useState<VocabularyView | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  async function run(task: () => Promise<void>) { setBusy(true); setError(""); setMessage(""); try { await task(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function refresh(offset = list.offset) { setList(await api<VocabularyList>(`/api/vocabulary?q=${encodeURIComponent(query)}&offset=${offset}`)); }
  async function save() { if (!editing) return; await run(async () => {
    await api(`/api/vocabulary/${editing.id}`, { method: "PUT", body: { term: editing.term, meaning: editing.meaning, example: editing.example } }); setEditing(null); await refresh(); setMessage("词语修改已保存。");
  }); }
  async function remove(id: string) { if (!window.confirm("从个人词汇库中删除这个词语？观点原文仍会保留。")) return; await run(async () => { await api(`/api/vocabulary/${id}`, { method: "DELETE" }); await refresh(0); setMessage("词语已删除。"); }); }
  return <div className="thought-lab">
    <header className="thought-page-heading"><div><p className="eyebrow">PERSONAL VOCABULARY / 自己的表达素材</p><h1 className="page-title">个人词汇库<span>留下你真正想用的词。</span></h1><p>从观点表达中收藏词语，保留释义与语境，再按自己的用法修改。</p></div><BookOpen size={36} strokeWidth={1} /></header>
    <nav className="thought-subnav" aria-label="个人素材导航"><Link href="/thoughts">01 / 观点实验室</Link><Link href="/vocabulary" aria-current="page">02 / 个人词汇库</Link><Link href="/review">03 / 今日复习</Link></nav>
    <form className="thought-vocabulary-search" onSubmit={e => { e.preventDefault(); void run(() => refresh(0)); }}><Input aria-label="搜索词汇" value={query} maxLength={100} onChange={e => setQuery(e.target.value)} placeholder="搜索英文词语或中文释义…" /><Button variant="outline" disabled={busy} type="submit"><Search size={16} />搜索</Button><span>{list.total} 个词语</span></form>
    {error && <p role="alert" className="thought-notice is-error">{error}</p>}{message && <p role="status" className="thought-notice">{message}</p>}
    {editing && <section className="thought-word-editor" aria-label="编辑收藏词语"><h2>编辑词语</h2><Label htmlFor="vocab-term">英文词语</Label><Input id="vocab-term" lang="en" value={editing.term} maxLength={100} disabled={busy} onChange={e => setEditing({ ...editing, term: e.target.value })} /><Label htmlFor="vocab-meaning">中文释义</Label><Input id="vocab-meaning" value={editing.meaning} maxLength={300} disabled={busy} onChange={e => setEditing({ ...editing, meaning: e.target.value })} /><Label htmlFor="vocab-example">例句或使用笔记</Label><Textarea id="vocab-example" value={editing.example} maxLength={800} rows={3} disabled={busy} onChange={e => setEditing({ ...editing, example: e.target.value })} /><div className="thought-actions"><Button disabled={busy} onClick={() => void save()}>保存词语修改</Button><Button variant="ghost" disabled={busy} onClick={() => setEditing(null)}>取消</Button></div></section>}
    {list.items.length ? <ul className="thought-word-grid">{list.items.map(word => <li key={word.id}><div className="thought-word-heading"><strong lang="en">{word.term}</strong><div><button type="button" disabled={busy} onClick={() => setEditing(word)} aria-label={`编辑 ${word.term}`}><Pencil size={16} /></button><button type="button" disabled={busy} onClick={() => void remove(word.id)} aria-label={`删除 ${word.term}`}><Trash2 size={16} /></button></div></div><p>{word.meaning}</p><blockquote lang="en">{word.example}</blockquote><footer><small>{formatDateTime(word.updatedAt)}</small>{word.thoughtId && <Link href={`/thoughts?thought=${word.thoughtId}`}>回到原观点 ↗</Link>}</footer></li>)}</ul> : <div className="thought-empty"><BookOpen size={30} /><h2>{query ? "没有匹配的词语" : "词语有语境，才更容易用起来。"}</h2><p>在观点实验室生成表达后，勾选你想掌握的词语，一键加入这里。</p><Link href="/thoughts">去整理一份观点 →</Link></div>}
    {list.total > list.pageSize && <div className="thought-actions"><Button variant="outline" disabled={busy || list.offset === 0} onClick={() => void run(() => refresh(list.offset - list.pageSize))}>上一页</Button><span>{Math.floor(list.offset / list.pageSize) + 1} / {Math.ceil(list.total / list.pageSize)}</span><Button variant="outline" disabled={busy || list.offset + list.pageSize >= list.total} onClick={() => void run(() => refresh(list.offset + list.pageSize))}>下一页</Button></div>}
  </div>;
}
