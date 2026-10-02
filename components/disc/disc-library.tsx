"use client";
import { ArrowLeft,ArrowRight,ArrowUp,ArrowDown,ArrowUpRight,List,Mic,Search,X } from "lucide-react";
import Link from "next/link";
import { useCallback,useEffect,useMemo,useRef,useState } from "react";
import type { QuestionContent } from "@/lib/content/types";
import { StartSessionButton } from "@/components/start-session-button";
import { DraftBadge } from "@/components/ui/badge";
import { DiscScene } from "./disc-scene";
import { ArchiveCatalog } from "./rhine/catalog";
import type { ArchiveNavigation } from "./rhine/archive-loop";
import { useRhine } from "./rhine-provider";
import { practiceHref } from "@/lib/client/practice-location";
import { TerminalShortcuts } from "@/components/terminal-shortcuts";
import { useTerminalEntry } from "@/components/auth/terminal-entry";

type Question=Omit<QuestionContent,"reviewStatus">&{version?:number;reviewStatus:string};
export function DiscLibrary({questions,records,initialPart,initialTopic,initialQuery,initialDisc,explicitLocation}:{questions:Question[];records:{questionId:string;count:number;latestId:string}[];initialPart:number;initialTopic:string;initialQuery:string;initialDisc?:string;explicitLocation?:boolean}){
  const rhine=useRhine();
  const entryPhase=useTerminalEntry()?.phase??"idle";
  const selecting=entryPhase==="selecting";
  const saved=explicitLocation?null:rhine?.library;
  const [part,setPart]=useState(saved?.part??initialPart),[topic,setTopic]=useState(saved?.topic??initialTopic),[query,setQuery]=useState(saved?.query??initialQuery);
  const [selected,setSelected]=useState(initialDisc??saved?.selected??"P1-HOME-1"),[navigation,setNavigation]=useState<ArchiveNavigation>(),[listOpen,setListOpen]=useState(false),[loading,setLoading]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null);
  const topics=useMemo(()=>Array.from(new Map(questions.filter(q=>q.part===part).map(q=>[q.topic,q.topicName]))),[questions,part]);
  const filtered=useMemo(()=>questions.filter(q=>q.part===part&&(!topic||q.topic===topic)&&`${q.id} ${q.text} ${q.zh} ${q.topicName}`.toLowerCase().includes(query.trim().toLowerCase())),[questions,part,topic,query]);
  const index=Math.max(0,filtered.findIndex(q=>q.id===selected)),q=filtered[index];
  const ids=useMemo(()=>filtered.map(q=>q.id),[filtered]);
  const columns=useMemo(()=>filtered.map(q=>q.topicName),[filtered]);
  const catalog=useMemo(()=>new ArchiveCatalog(filtered.map(q=>({id:q.id,column:q.topicName}))),[filtered]);
  const record=records.find(r=>r.questionId===q?.id);
  const select=useCallback((i:number,nav?:ArchiveNavigation)=>{if(filtered[i]){setSelected(filtered[i].id);setNavigation(nav);}},[filtered]);
  const navigate=useCallback((axis:"row"|"lane",direction:number)=>select(catalog.navigate(index,axis,direction),{axis,direction}),[catalog,index,select]);
  const lane=catalog.fileLocation(index).lane,rows=catalog.columnFiles(lane),rowIndex=rows.indexOf(index);
  const remember=rhine?.remember;
  useEffect(()=>{
    if(!q)return;
    const location={part,topic,query,selected:q.id};
    remember?.(location);
    const href=practiceHref(location);
    if(window.location.pathname==="/practice"&&window.location.pathname+window.location.search!==href)window.history.replaceState(window.history.state,"",href);
  },[part,topic,query,q?.id,remember]);
  useEffect(()=>{
    const el=dialog.current;if(!el)return;if(listOpen&&!el.open)el.showModal();else if(!listOpen&&el.open)el.close();
  },[listOpen]);
  useEffect(()=>{
    const key=(e:KeyboardEvent)=>{
      if(entryPhase!=="idle"||listOpen||loading||e.altKey||e.ctrlKey||e.metaKey||/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName))return;
      if(e.key==="/"){e.preventDefault();setListOpen(true);}
      const axis=e.key==="ArrowUp"||e.key==="ArrowDown"?"row":e.key==="ArrowLeft"||e.key==="ArrowRight"?"lane":null;
      if(axis){e.preventDefault();navigate(axis,e.key==="ArrowUp"||e.key==="ArrowLeft"?-1:1);}
      if(e.key==="Enter"&&(e.target===document.body||(e.target as HTMLElement).classList.contains("disc-library"))){e.preventDefault();document.querySelector<HTMLButtonElement>(`[data-testid="practice-${q?.id}"]`)?.click();}
    };window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);
  },[listOpen,loading,navigate,q?.id,entryPhase]);
  return <div className="disc-library rhine-library" data-loading={loading} tabIndex={-1}>
    <h1 className="sr-only">训练磁盘 · 题库自由练习</h1>
    <TerminalShortcuts className="rhine-library-shortcuts"/>
    <div className="rhine-library-tools"><div className="terminal-tabs" aria-label="题型">{[1,2,3].map(p=><button key={p} aria-pressed={part===p} disabled={loading} onClick={()=>{setPart(p);setTopic("");setNavigation(undefined);}}>PART {p}<span>{questions.filter(q=>q.part===p).length}</span></button>)}</div><button className="rhine-index-button" onClick={()=>setListOpen(true)}><Search size={19}/>题库索引<span>/</span></button></div>
    {q?<>
      <DiscScene variant="library" ids={ids} columns={columns} selected={index} navigation={navigation} intro={selecting} onSelect={loading||selecting?undefined:select}/>
      <section className="rhine-callout disc-detail" data-testid={`q-${q.id}`}>
        <p className="rhine-eyebrow">TRAINING DATABASE <span>/</span> {q.topicName}</p>
        <h2 className="rhine-file-title">{selecting&&<span className="rhine-selecting-files" aria-hidden="true">SELECTING FILES…</span>}<span className="rhine-selected-title"><span>DISC:</span><span key={q.id} className="rhine-rolling">{q.id}</span><ArrowUpRight size={24}/></span></h2>
        <div className="rhine-callout-rule"><i/></div>
        <div className="rhine-file-summary"><strong key={q.topicName} className="rhine-rolling">{q.topicName}</strong><span>PART {q.part} / {["","基础问答","话题陈述","深入讨论"][q.part]}</span></div>
        <p className="rhine-question-preview" key={q.text}>{q.text}</p>
        <div className="rhine-access-row"><StartSessionButton input={{mode:"practice",questionId:q.id}} testId={`practice-${q.id}`} className="rhine-load-button" cinematic onPendingChange={setLoading}>载入训练盘<ArrowRight size={25}/></StartSessionButton>{record&&<Link href={`/answers/${record.latestId}`}>我的 {record.count} 次记录<ArrowUpRight size={16}/></Link>}</div>
        <div className="rhine-topic-tags"><span>{["","入门","进阶","挑战"][q.difficulty]}</span>{q.reviewStatus!=="approved"&&<DraftBadge/>}</div>
      </section>
      <div className="rhine-counter"><span>DISC / SELECT</span><div><strong key={q.id} className="rhine-rolling">{String(rowIndex+1).padStart(2,"0")}</strong><i>/</i><span>{String(rows.length).padStart(2,"0")}</span></div></div>
      <div className="rhine-row-navigation"><button disabled={loading} aria-label="上一张磁盘" onClick={()=>navigate("row",-1)}><ArrowUp/></button><div className="rhine-ticks">{rows.map((n,i)=><button key={ids[n]} disabled={loading} aria-label={`选择磁盘 ${ids[n]}`} aria-pressed={index===n} onClick={()=>select(n)} style={{display:rows.length>12&&Math.abs(i-rowIndex)>5?"none":undefined}}><i/></button>)}</div><button disabled={loading} aria-label="下一张磁盘" onClick={()=>navigate("row",1)}><ArrowDown/></button></div>
      <div className="rhine-column-navigation"><button disabled={loading||catalog.columns.length<2} aria-label="上一主题" onClick={()=>navigate("lane",-1)}><ArrowLeft/></button><div><span>COLUMN {String(lane+1).padStart(2,"0")} / {String(catalog.columns.length).padStart(2,"0")}</span><strong key={q.topicName} className="rhine-rolling">{q.topicName}</strong></div><button disabled={loading||catalog.columns.length<2} aria-label="下一主题" onClick={()=>navigate("lane",1)}><ArrowRight/></button></div>
    </>:<div className="disc-empty"><h2>没有找到匹配的训练盘</h2><p>换一个关键词，或清除主题筛选。</p><button onClick={()=>{setQuery("");setTopic("");}}>清除筛选</button></div>}
    <footer className="rhine-library-footer"><span><i/> PERSONAL TRAINING DATABASE</span><span className="rhine-key-hint">← → 切换主题　 /　 ↑ ↓ 翻阅磁盘　 /　 ENTER 载入</span><div><Link href="/device-check"><Mic size={14}/>检查麦克风</Link><Link href="/mock">完整模考<ArrowUpRight size={14}/></Link></div></footer>
    <dialog ref={dialog} className="rhine-index-dialog" onCancel={()=>setListOpen(false)} onClick={e=>{if(e.target===dialog.current)setListOpen(false);}}>
      <div><header><div><p>TRAINING / INDEX</p><h2>题库索引</h2></div><button aria-label="关闭题库索引" onClick={()=>setListOpen(false)}><X/></button></header>
      <label className="disc-search"><Search size={18}/><input type="search" aria-label="检索题目" placeholder="搜索题号、主题或问题" value={query} onChange={e=>setQuery(e.target.value)}/></label>
      <label className="rhine-topic-filter">主题<select aria-label="筛选主题" value={topic} onChange={e=>setTopic(e.target.value)}><option value="">全部主题</option>{topics.map(([code,name])=><option key={code} value={code}>{name}</option>)}</select><span>{filtered.length} 张训练盘</span></label>
      <section className="disc-text-list" aria-label="题目列表">{filtered.map((item,i)=><button key={item.id} aria-pressed={i===index} onClick={()=>{select(i);setListOpen(false);}}><span>{item.id}</span><strong>{item.text}</strong><ArrowUpRight size={16}/></button>)}{!filtered.length&&<div className="rhine-index-empty"><p>没有找到匹配的训练盘</p><button onClick={()=>{setQuery("");setTopic("");}}>清除筛选</button></div>}</section>
      </div>
    </dialog>
  </div>;
}
