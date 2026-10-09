import type { Metadata } from "next";
import { requireUser } from "@/lib/auth-server";
import { listVocabulary } from "@/lib/services/thoughts";
import { VocabularyBank } from "@/components/thoughts/vocabulary-bank";
export const metadata: Metadata = { title: "个人词汇库" };
export default async function VocabularyPage() { const u = await requireUser(); return <VocabularyBank initial={await listVocabulary(u.id)} />; }
