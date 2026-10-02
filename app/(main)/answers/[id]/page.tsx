import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth-server";
import { AppError } from "@/lib/errors";
import { answerHistory, getAnswerDetail } from "@/lib/services/answers";
import { ProcessingRefresh } from "@/components/report/processing-refresh";
import { RecordArchive } from "@/components/disc/record-archive";
import { Alert } from "@/components/ui/feedback";
export const metadata: Metadata = {title:"记录回放"};
export default async function AnswerDetailPage({params}:{params:Promise<{id:string}>}){
 const u=await requireUser();const {id}=await params;let d;
 try{d=await getAnswerDetail(u,id);}catch(e){if(e instanceof AppError&&e.status===404)notFound();throw e;}
 const history=d.own ? await answerHistory(u.id,d.answer.questionId):[];
 return <><ProcessingRefresh pending={["queued","processing","uploaded"].includes(d.answer.status)}/>{!d.own&&<Alert tone="info" className="mb-4">管理员查看模式（该用户已授权用于排查）。</Alert>}<RecordArchive key={id} {...JSON.parse(JSON.stringify({answer:d.answer,feedback:d.feedback,history,question:d.question?.content??null,session:d.session,own:d.own}))}/></>;
}
