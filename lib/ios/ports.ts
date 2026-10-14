/** Candidate boundaries for the iOS client. Native implementations are still pending. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type PracticeMode = "level" | "mock" | "practice" | "retry";
export type RecordingStatus = "idle" | "permission_required" | "ready" | "recording" | "stopped" | "interrupted" | "pending_upload" | "uploading" | "processing" | "complete" | "failed" | "revoked";
export type InterruptionReason = "background" | "phone_call" | "route_changed" | "permission_revoked" | "account_changed" | "consent_withdrawn" | "session_expired";

export interface AccountScope {
  userId: string;
  /** Changes on login/logout/account switch, including a new login by the same user. */
  epoch: string;
  consentVersion: number;
}

export interface SessionSummary {
  userId: string;
  expiresAt: string;
  mustChangePassword: boolean;
  onboarded: boolean;
}

/** Credentials live in native secure storage; JavaScript does not persist the raw token. */
export interface AuthenticationPort {
  signIn(email: string, password: string, signal?: AbortSignal): Promise<SessionSummary>;
  current(): Promise<SessionSummary | null>;
  signOut(): Promise<void>;
  /** Clears local credentials immediately, even if server revocation is temporarily offline. */
  invalidate(reason: "expired" | "password_changed" | "deleted" | "account_changed"): Promise<void>;
}

export interface FileReference {
  /** An opaque application-owned reference, not an arbitrary filesystem path. */
  id: string;
  scope: AccountScope;
  bytes: number;
  mimeType: "audio/mp4" | "audio/wav";
  createdAt: string;
  expiresAt: string;
}

export interface RecordingResult {
  submissionId: string;
  file: FileReference;
  durationMs: number;
  interrupted: boolean;
}

export interface RecorderPort {
  permission(): Promise<"prompt" | "granted" | "denied" | "restricted">;
  requestPermission(): Promise<"granted" | "denied" | "restricted">;
  start(input: { scope: AccountScope; submissionId: string; maxDurationMs: number }): Promise<{ startedAtMonotonicMs: number }>;
  stop(): Promise<RecordingResult>;
  interrupt(reason: InterruptionReason): Promise<RecordingResult | null>;
  release(): Promise<void>;
}

export interface RecordingStoragePort {
  listRecoverable(scope: AccountScope, now: Date): Promise<RecordingResult[]>;
  commit(result: RecordingResult): Promise<void>;
  remove(file: FileReference): Promise<void>;
  clearAccount(userId: string): Promise<void>;
  exportWithUserConfirmation(file: FileReference): Promise<void>;
}

export interface TransportPort {
  /** Uses the configured backend allowlist and native session; never arbitrary authenticated URLs. */
  request<T>(request: { path: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: JsonValue; signal?: AbortSignal }): Promise<T>;
  upload(input: { path: string; file: FileReference; submissionId: string; consentVersion: number; signal?: AbortSignal }): Promise<{ answerId: string }>;
}

export interface PlaybackPort {
  playPrivateAnswer(answerId: string, scope: AccountScope): Promise<void>;
  stopAndRelease(): Promise<void>;
  clearAccountCache(userId: string): Promise<void>;
}

export interface ClockPort {
  monotonicMs(): number;
  wallTimeMs(): number;
  /** Uses the existing server-time sampling rule; a suspended callback is not a new deadline. */
  serverOffsetMs(): number;
}

export interface LifecyclePort {
  subscribe(listener: (event: "foreground" | "background" | "network_restored" | "network_lost") => void): () => void;
}
