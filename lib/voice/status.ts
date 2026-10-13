export interface VoiceStatus {
  state: "ready" | "unprepared" | "unavailable" | "not_required";
  provider: "local" | "cloud" | "mock";
  voiceLabel: string;
  checkedAt: string;
  checkedFiles: number;
  totalFiles: number;
  problemFile?: string;
  message: string;
}
