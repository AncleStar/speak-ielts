import { AudioLines } from "lucide-react";
import { cn } from "@/lib/utils";
export type ExaminerState = "waiting" | "speaking" | "listening" | "processing";
const LABEL:Record<ExaminerState,string>={waiting:"等待开始",speaking:"考官提问中",listening:"正在倾听",processing:"正在整理记录"};
export function ExaminerAvatar({state,className}:{state:ExaminerState;className?:string}){
 return <div className={cn("examiner-window",className)} data-testid="examiner" data-state={state}><div className="examiner-portrait"><img src="/images/examiner-emma.webp" alt="虚拟考官 Emma" width="512" height="512"/><span>VIRTUAL EXAMINER</span></div><p>Emma <span>/ 虚拟考官</span></p><div aria-live="polite"><AudioLines size={18}/>{LABEL[state]}</div></div>;
}
