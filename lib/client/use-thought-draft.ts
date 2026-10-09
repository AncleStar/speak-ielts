"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { deleteThoughtDraft, localIdentity, saveThoughtDraft } from "./idb";
import type { ThoughtDraft } from "@/lib/thoughts/draft";
type Content = ThoughtDraft extends infer D ? D extends ThoughtDraft ? Omit<D, "id" | "userId" | "localEpoch" | "savedAt"> : never : never;
/** Each mounted editor has a separate draft, so another tab never silently overwrites it. */
export function useThoughtDraft(content: Content, active: boolean) {
  const [status, setStatus] = useState(""), writer = useRef(crypto.randomUUID()), scope = useRef(localIdentity());
  const chain = useRef(Promise.resolve()), generation = useRef(0), live = useRef(true);
  const serialized = JSON.stringify(content);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    const id = writer.current, version = ++generation.current, owner = scope.current;
    if (!owner?.userId) return;
    if (active) setStatus("正在暂存草稿…"); else setStatus("");
    chain.current = chain.current.catch(() => {}).then(async () => {
      if (version !== generation.current) return;
      if (!active) { await deleteThoughtDraft(id); return; }
      const draft = { ...JSON.parse(serialized), id, userId: owner.userId, localEpoch: owner.epoch, savedAt: Date.now() } as ThoughtDraft;
      const saved = await saveThoughtDraft(draft);
      if (live.current && version === generation.current) setStatus(saved ? "草稿已在本机暂存 · 保留 24 小时" : "本机存储受限，草稿仅在当前页面内存中，刷新或关闭可能丢失。");
    }).catch(() => { if (live.current && version === generation.current) setStatus("草稿未能保存，请先保留当前输入并检查浏览器存储。"); });
  }, [serialized, active]);
  const clear = useCallback(async () => { ++generation.current; await chain.current.catch(() => {}); await deleteThoughtDraft(writer.current); writer.current = crypto.randomUUID(); if (live.current) setStatus(""); }, []);
  const fork = useCallback(async () => { await chain.current.catch(() => {}); ++generation.current; writer.current = crypto.randomUUID(); if (live.current) setStatus(""); }, []);
  return { status, clear, fork };
}
