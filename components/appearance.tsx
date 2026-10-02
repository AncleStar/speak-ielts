"use client";
import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
type Preferences = { theme: "light" | "dark"; transparency: boolean; motion: boolean };
const defaults: Preferences = { theme: "light", transparency: false, motion: false };
function read(): Preferences { try { return { ...defaults, ...JSON.parse(localStorage.getItem("speak-appearance") ?? "{}") }; } catch { return defaults; } }
function apply(p: Preferences) { const el = document.documentElement; el.dataset.theme = p.theme; el.dataset.transparency = p.transparency ? "reduced" : "full"; el.dataset.motion = p.motion ? "reduced" : "full"; }
export function AppearanceInit() { useEffect(() => { apply(read()); }, []); return null; }
export function AppearanceSettings() {
  const [prefs, setPrefs] = useState(defaults);
  useEffect(() => { setPrefs(read()); }, []);
  function update(patch: Partial<Preferences>) { const next = { ...prefs, ...patch }; setPrefs(next); apply(next); try { localStorage.setItem("speak-appearance", JSON.stringify(next)); } catch {} }
  return <Card className="mb-5"><CardContent className="space-y-4 pt-5"><h2 className="font-semibold">界面与显示</h2><label className="flex min-h-11 flex-wrap items-center justify-between gap-3 text-sm">外观<select aria-label="外观" value={prefs.theme} onChange={e => update({ theme: e.target.value as Preferences["theme"] })} className="min-h-11 rounded-xl border border-line bg-surface px-4"><option value="light">浅色 · 暖灰终端</option><option value="dark">深色 · 墨绿终端</option></select></label><label className="flex min-h-11 items-center justify-between gap-3 text-sm">减少透明效果<input type="checkbox" checked={prefs.transparency} onChange={e => update({ transparency: e.target.checked })} className="h-5 w-5" /></label><label className="flex min-h-11 items-center justify-between gap-3 text-sm">减少动态效果<input type="checkbox" checked={prefs.motion} onChange={e => update({ motion: e.target.checked })} className="h-5 w-5" /></label><p className="text-xs text-muted">偏好保存在本机，也会尊重系统的减少动态效果设置。</p></CardContent></Card>;
}

