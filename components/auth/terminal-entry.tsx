"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { TerminalScan } from "./terminal-scan";
import { SpeakBrand } from "@/components/nav";
import { ENTRY_TIMING } from "@/lib/client/terminal-entry-timing";

type Phase = "idle" | "opening" | "waiting" | "selecting";
type Entry = { phase: Phase; begin: () => void; ready: (value: boolean) => void };
const EntryContext = createContext<Entry | null>(null);
export const useTerminalEntry = () => useContext(EntryContext);
const motionReduced = () => {
  let paused = false;
  try { paused = localStorage.getItem("ambient-paused") === "true"; } catch {}
  return paused || matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduced";
};

/** Survives the auth → main route change, so the real scene loads under one curtain. */
export function TerminalEntryProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter(), path = usePathname();
  const [phase, setPhase] = useState<Phase>("idle"), [sceneReady, ready] = useState(false);
  const started = useRef(false), reachedPractice = useRef(false);
  const finish = useCallback(() => {
    started.current = false;
    setPhase("idle");
    if (path === "/practice") requestAnimationFrame(() => document.querySelector<HTMLElement>(".disc-library")?.focus({ preventScroll: true }));
  }, [path]);
  const begin = useCallback(() => {
    if (started.current) return;
    started.current = true;
    reachedPractice.current = false;
    ready(false);
    setPhase(motionReduced() ? "idle" : "opening");
    router.replace("/practice");
  }, [router]);
  const skip = useCallback(() => {
    finish();
    if (path === "/login") router.replace("/practice");
  }, [finish, path, router]);
  useEffect(() => {
    if (path === "/practice") reachedPractice.current = true;
    else if (reachedPractice.current || path !== "/login") finish();
  }, [path, finish]);
  useEffect(() => { if (phase === "waiting" && sceneReady) setPhase("selecting"); }, [phase, sceneReady]);
  const openingDone = useCallback(() => setPhase(sceneReady ? "selecting" : "waiting"), [sceneReady]);
  const value = useMemo(() => ({ phase, begin, ready }), [phase, begin]);
  return <EntryContext.Provider value={value}>
    <div className="terminal-entry-content" inert={phase !== "idle"}>{children}</div>
    {phase !== "idle" && <EntryOverlay phase={phase} openingDone={openingDone} finish={finish} skip={skip}/>}
  </EntryContext.Provider>;
}

function EntryOverlay({ phase, openingDone, finish, skip }: { phase: Exclude<Phase,"idle">; openingDone: () => void; finish: () => void; skip: () => void }) {
  const [clock, setClock] = useState({ phase, elapsed: 0 });
  const elapsed = clock.phase === phase ? clock.elapsed : 0;
  const actions = useRef({ openingDone, finish, skip });
  actions.current = { openingDone, finish, skip };
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { button.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    let raf = 0, previous = 0, time = 0;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = (now: number) => {
      if (document.hidden) { previous = 0; return; }
      // CSS and the scene use real visible time; clamping here lets slow frames
      // leave welcome text over an already-revealed library on mobile.
      time += previous ? (now - previous) / 1000 : 0;
      previous = now;
      setClock({ phase, elapsed: time });
      if (phase === "opening" && time >= ENTRY_TIMING.opening) { actions.current.openingDone(); return; }
      if (phase === "selecting" && time >= ENTRY_TIMING.selection || phase === "waiting" && time >= 12) { actions.current.finish(); return; }
      raf = requestAnimationFrame(update);
    };
    const preferences = () => { if (motionReduced()) actions.current.skip(); };
    const visibility = () => { cancelAnimationFrame(raf); previous = 0; document.documentElement.dataset.entryPaused=String(document.hidden); if (!document.hidden) raf = requestAnimationFrame(update); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") actions.current.skip(); };
    const observer = new MutationObserver(preferences);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
    query.addEventListener("change", preferences);
    window.addEventListener("ambient-pause-change", preferences);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("keydown", key);
    setClock({ phase, elapsed: 0 }); preferences(); visibility();
    return () => { cancelAnimationFrame(raf); delete document.documentElement.dataset.entryPaused; observer.disconnect(); query.removeEventListener("change", preferences); window.removeEventListener("ambient-pause-change", preferences); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("keydown", key); };
  }, [phase]);
  // Welcome remains mounted across the route and phase changes: no cut or replay.
  const welcomeTime = phase === "opening" ? elapsed : ENTRY_TIMING.opening;
  return <div className="terminal-entry" role="dialog" aria-label="进入训练终端" aria-modal="true" data-phase={phase} data-testid="terminal-entry">
    <div className="terminal-entry-curtain">
      <div className="rhine-auth-header" aria-hidden="true"><div><SpeakBrand/></div></div>
      <TerminalScan authorized elapsed={Math.min(welcomeTime, ENTRY_TIMING.scan)} scanOnly/>
      <div className="terminal-welcome" data-visible={welcomeTime >= ENTRY_TIMING.scan}>
        <p className="terminal-welcome-heading"><span>WELCOME TO</span></p>
        <div className="terminal-welcome-company"><strong>SPEAK TRAINING</strong><strong className="terminal-welcome-highlight" aria-hidden="true">SPEAK TRAINING</strong></div>
        <p className="terminal-welcome-database"><span>PERSONAL DATABASE</span></p>
        <span className="terminal-welcome-note">你的下一次进步，从这里开始。</span>
      </div>
    </div>
    <div className="terminal-entry-controls">
      <p role="status">{phase === "waiting" ? "正在准备训练磁盘…" : phase === "selecting" ? "正在展开训练磁盘" : "登录成功，正在进入训练终端"}</p>
      <button ref={button} onClick={skip}>跳过动画，进入系统<ArrowRight size={18}/></button>
    </div>
  </div>;
}
