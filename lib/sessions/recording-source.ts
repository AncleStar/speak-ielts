export type RecordingSource = "accepted" | "current_device" | "retained_before_pause" | "previous_device" | "unverified_device" | "local_snapshot";
export function recordingSource(input: { currentActivationId: string | null; recordingActivationId?: string | null; started: boolean; retainedBeforePause: boolean; interrupted: boolean }) {
  if (input.retainedBeforePause) return { source: "retained_before_pause" as const, interrupted: input.interrupted };
  if ((input.recordingActivationId && input.recordingActivationId === input.currentActivationId) || (!input.started && !input.currentActivationId)) return { source: "current_device" as const, interrupted: input.interrupted };
  return { source: input.recordingActivationId ? "previous_device" as const : "unverified_device" as const, interrupted: true };
}
export function recordingSourceNote(source?: string | null) {
  return source === "local_snapshot" ? "本机中断副本：仅保存当时已写入的片段，不计作完整作答。" : source === "previous_device" ? "旧设备补传片段：已保留录音，不计作当前设备的完整作答。" : source === "unverified_device" ? "无法确认旧录音来自哪次练习：已保留为中断片段，请重新完整作答。" : null;
}
