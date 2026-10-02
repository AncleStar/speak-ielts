export function words(text: string) { return text.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? []; }
/** Word error rate, not a pronunciation or IELTS score. Empty references return null. */
export function wordErrorRate(reference: string, recognized: string) {
  const ref = words(reference), hyp = words(recognized);
  if (!ref.length) return null;
  let row = hyp.map((_, i) => i + 1); row.unshift(0);
  for (let i = 1; i <= ref.length; i++) {
    const next = [i];
    for (let j = 1; j <= hyp.length; j++) next[j] = Math.min(next[j-1] + 1, row[j] + 1, row[j-1] + Number(ref[i-1] !== hyp[j-1]));
    row = next;
  }
  return { errors: row[hyp.length], referenceWords: ref.length, rate: row[hyp.length] / ref.length };
}
