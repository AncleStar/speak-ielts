import type { Metadata } from "next";
import { InterviewRoom } from "@/components/interview/interview-room";
import { requireUser } from "@/lib/auth-server";

export const metadata: Metadata = { title: "面试室" };

export default async function InterviewPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const u = await requireUser();
  const { sessionId } = await params;
  const pref = (["auto", "always", "never"].includes(u.subtitlePref) ? u.subtitlePref : "auto") as "auto" | "always" | "never";
  return <InterviewRoom sessionId={sessionId} subtitlePref={pref} userId={u.id} />;
}
