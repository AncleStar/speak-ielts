"use client";
import { useEffect, useState } from "react";
import { Pause, Play } from "lucide-react";
const PAUSE_EVENT = "ambient-pause-change";
function useAmbientPause() {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const read = () => { try { setPaused(localStorage.getItem("ambient-paused") === "true"); } catch { setPaused(true); } };
    const update = (event: Event) => setPaused((event as CustomEvent<boolean>).detail);
    read();
    window.addEventListener("storage", read);
    window.addEventListener(PAUSE_EVENT, update);
    return () => { window.removeEventListener("storage", read); window.removeEventListener(PAUSE_EVENT, update); };
  }, []);
  function toggle() {
    try { localStorage.setItem("ambient-paused", String(!paused)); } catch { /* Keep the control available when storage is blocked. */ }
    window.dispatchEvent(new CustomEvent(PAUSE_EVENT, { detail: !paused }));
  }
  return { paused, toggle };
}
export function AmbientToggle({ floating = false }: { floating?: boolean }) {
  const { paused, toggle } = useAmbientPause();
  return <button type="button" className={`ambient-toggle glass-pill${floating ? " ambient-toggle-floating" : ""}`} onClick={toggle} aria-pressed={paused} aria-label={paused ? "播放背景动画" : "暂停背景动画"} title={paused ? "播放背景动画" : "暂停背景动画"}>
    {paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}<span className={floating ? undefined : "hidden lg:inline"}>背景</span>
  </button>;
}
export function AmbientBackground({ variant = "app" }: { variant?: "app" | "auth" }) {
  const { paused } = useAmbientPause();
  return <>
    <div className={`ambient-background ambient-${variant}`} data-paused={paused} aria-hidden="true"><i /><i /><i /><div className="ambient-grid" /></div>
    {variant === "auth" && <AmbientToggle floating />}
  </>;
}
