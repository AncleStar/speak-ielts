export type PracticeLocation = { part: number; topic: string; query: string; selected: string };

export function practiceHref(value: PracticeLocation | null) {
  if (!value) return "/practice";
  const params = new URLSearchParams({ part: String(value.part), disc: value.selected });
  if (value.topic) params.set("topic", value.topic);
  if (value.query) params.set("q", value.query);
  return `/practice?${params}`;
}
