// Adapted from RhineLabUI, Copyright (c) 2026 LBEILC, MIT. See public/licenses/rhine-lab-ui.txt.
/** Reference coordinates remain exact during the film and at 1920 × 1080. */
export function openingLayout(width: number, height: number) {
  width = Math.max(1, width); height = Math.max(1, height);
  const scale = Math.min(height / 1080, width / 1280);
  return { width: width / scale, height: height / scale, scale, kind: "opening" as const };
}
export function viewportLayout(width: number, height: number, coarse: boolean, cinematic = false) {
  width = Math.max(1, width);
  height = Math.max(1, height);
  if (cinematic) return {
    width: 1920, height: 1080, scale: Math.min(width / 1920, height / 1080),
    kind: "cinematic" as const,
  };
  const portrait = width / height < 1.05;
  const compact = portrait || width < 1100 || (coarse && height < 600);
  const scale = compact ? 1 : height / 1080;
  return { width: width / scale, height: height / scale, scale,
    kind: portrait ? "portrait" as const : compact ? "compact" as const : "desktop" as const };
}

export interface ArtworkFrame { left: number; top: number; width: number; height: number }

/** Preserve the long-lens perspective. Reframe only the camera, never the card. */
export function archiveFraming(width: number, height: number, span: number, detail: number, compact: boolean, artwork?: ArtworkFrame) {
  const aspect = width / height;
  const portrait = aspect < 1.05;
  const baseSpan = span + (5.9 - span) * detail;
  const fittedSpan = artwork ? Math.max(6.3 * height / artwork.width, 4.2 * height / artwork.height) : 0;
  const portraitDetailSpan = artwork ? fittedSpan : Math.max(6.3 / aspect, 3.7 * height / Math.max(100, 0.54 * height - 156));
  const viewSpan = artwork
    ? Math.max(baseSpan, Math.max(8.4 / aspect, fittedSpan) * (1 - detail) + fittedSpan * detail)
    : portrait
    ? Math.max(baseSpan, 8.4 / aspect + (portraitDetailSpan - 8.4 / aspect) * detail)
    : Math.max(baseSpan, baseSpan * (16 / 9) / aspect);
  return {
    span: viewSpan,
    portrait,
    artwork: Boolean(artwork),
    // Portrait selection is deliberately above its title and navigation.
    previewX: artwork ? (artwork.left + artwork.width / 2) / width : 0.5,
    previewY: artwork ? (artwork.top + artwork.height / 2) / height : portrait ? 0.36 : 0.5,
    detailX: artwork ? (artwork.left + artwork.width / 2) / width : portrait ? 0.5 : compact ? 0.27 : 550 / 1920,
    detailY: artwork ? (artwork.top + artwork.height / 2) / height : portrait ? 0.27 + 34 / height : compact ? 0.49 : 560 / 1080,
  };
}
