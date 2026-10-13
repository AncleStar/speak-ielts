/** Keep the latest full answer in front when an older-device fragment arrives later. */
export function replayAttempts<T extends { answer: { interrupted: boolean } }>(attempts: T[]): T[] {
  const latest = [...attempts].reverse(), full = latest.findIndex(a => !a.answer.interrupted);
  if (full > 0) latest.unshift(...latest.splice(full, 1));
  return latest;
}
