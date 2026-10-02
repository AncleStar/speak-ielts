"use client";
import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import type { QuestionContent } from "@/lib/content/types";
import { formatDateTime, formatDuration, MODE_LABEL } from "@/lib/utils";
import { AnswerCard, FeedbackBlock, type AnswerView, type FeedbackView } from "@/components/report/answer-card";
import { AttemptCompare, type HistoryEntry } from "@/components/report/compare";
import { ReferenceAudio } from "@/components/report/reference-audio";
import { RewardButton } from "@/components/rewards/reward-controls";
import { DiscScene } from "./disc-scene";
import { useRhine } from "./rhine-provider";

export function RecordArchive({answer,feedback,history,question,session,own}:{answer:AnswerView;feedback:FeedbackView|null;history:HistoryEntry[];question:QuestionContent|null;session:{id:string;title:string;mode:string};own:boolean}){
  const [tab,setTab]=useState("recording"),[playing,setPlaying]=useState(false);
  const rhine=useRhine();
  const stopPlayback=rhine?.stopPlayback;
  const onPlaybackChange=useCallback((value:boolean)=>{setPlaying(value);if(!value)stopPlayback?.();},[stopPlayback]);
  const recordId=`REC-${answer.id.slice(0,8).toUpperCase()}`;
  const tabs=[{id:"recording",name:"录音与转写"},{id:"feedback",name:"反馈报告"},...(own&&answer.kind==="main"?[{id:"compare",name:"同题对比"}]:[])];
  return <div className="record-archive">
    <aside className="record-sidebar"><Link href="/history" className="terminal-back"><ArrowLeft size={20}/>返回我的记录</Link><DiscScene variant="archive" ids={[recordId]} state={playing?"playing":"idle"}/><h2 className="record-id">{recordId}</h2><dl className="record-info"><dt>题目编号</dt><dd>{answer.questionId}</dd><dt>练习类型</dt><dd>{MODE_LABEL[session.mode]??session.mode}{question ? ` · Part ${question.part}` : ""}</dd><dt>录制时间</dt><dd>{formatDateTime(answer.createdAt)}</dd><dt>作答时长</dt><dd>{formatDuration((answer.durationMs??0)/1000)}</dd></dl>
      {own&&answer.kind==="main"&&<div className="record-history"><h3>本题的练习记录</h3><p className="text-xs text-muted mb-2">最近 {history.length} 次作答</p>{history.map((entry,i)=><Link key={entry.answer.id} href={`/answers/${entry.answer.id}`} aria-current={entry.answer.id===answer.id?"page":undefined}><span>{formatDateTime(entry.answer.createdAt)}</span><span>{formatDuration((entry.answer.durationMs??0)/1000)}</span><ArrowRight size={16}/></Link>)}</div>}
      <Link href={`/sessions/${session.id}`} className="terminal-back">查看本次完整报告<ArrowRight size={16}/></Link>
    </aside>
    <section className="record-body"><p className="disc-code">{answer.questionId}</p><h1>{question?.topicName??"个人记录盘"}</h1><p className="disc-topic-en">{question?.topic??"PERSONAL RECORD"} / SPEAK</p>
      <div className="terminal-tabs" role="tablist" aria-label="记录内容">{tabs.map(t=><button key={t.id} id={`tab-${t.id}`} role="tab" aria-selected={tab===t.id} aria-controls={`panel-${t.id}`} onClick={()=>{setPlaying(false);setTab(t.id);}}>{t.name}</button>)}</div>
      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} className="record-panel">
        <p className="terminal-kicker">题目内容 / QUESTION</p><h2 className="record-question">{answer.promptText}</h2>
        {tab==="recording"&&<><AnswerCard key={answer.id} answer={answer} feedback={feedback} showActions={own} recordingOnly onPlaybackChange={onPlaybackChange} summary={feedback&&<div className="record-next-goal"><p>{feedback.mock?"演示建议 · ":"下一次 · "}{feedback.data.nextGoal}</p><button onClick={()=>{setPlaying(false);setTab("feedback");}}>查看完整反馈<ArrowRight size={16}/></button><span>发音未评估</span></div>}/></>}
        {tab==="feedback"&&<>{feedback?<><FeedbackBlock fb={feedback}/>{own&&<ReferenceAudio answerId={answer.id}/>}</>:<p>反馈尚未生成，可返回“录音与转写”查看当前处理状态。</p>}{question&&<details className="record-question-notes"><summary>题目资料与参考回答</summary><p>{question.zh}</p><p>训练目标：{question.trainingGoal}</p><p>组织建议：{question.structureTips}</p><p>可用表达：{question.usefulExpressions.join(" / ")}</p><p>常见困难：{question.commonDifficulties.join(" / ")}</p><p>参考回答（示例，非考场标准答案）：{question.referenceAnswer}</p><p>题目审核状态：{question.reviewStatus==="approved"?"已审核":"尚未完成人工教学审核"}</p></details>}{own&&<div className="mt-5"><RewardButton action="review" answerId={answer.id}>我已复盘，准备重练</RewardButton></div>}</>}
        {tab==="compare"&&<AttemptCompare entries={history} currentId={answer.id}/>}
      </div>
    </section>
  </div>;
}

