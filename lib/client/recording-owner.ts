"use client";

// A browser releases this lock when the recording page crashes or closes.
// No age/heartbeat timeout can mistake a suspended live recorder for an orphan.
export const RECORDING_GUARD = "web-lock-v1" as const;
function manager() { return typeof navigator === "undefined" ? undefined : navigator.locks; }
function name(id: string) { return `speak-recording:${id}`; }

export async function holdRecording(id: string): Promise<{ guard?: typeof RECORDING_GUARD; release: () => void }> {
  const locks = manager();
  if (!locks) return { release: () => {} };
  let release!: () => void;
  const untilStopped = new Promise<void>(resolve => { release = resolve; });
  return new Promise((resolve, reject) => {
    void locks.request(name(id), { mode: "exclusive", ifAvailable: true }, async lock => {
      if (!lock) { reject(new Error("这段录音仍被另一页面占用。")); return; }
      resolve({ guard: RECORDING_GUARD, release });
      await untilStopped;
    }).catch(reject);
  });
}

/** Null means a live owner holds the lock, or this browser cannot verify it. */
export async function withStoppedRecording<T>(id: string, work: () => Promise<T>): Promise<T | null> {
  const locks = manager();
  if (!locks) return null;
  return locks.request(name(id), { mode: "exclusive", ifAvailable: true }, lock => lock ? work() : null);
}
