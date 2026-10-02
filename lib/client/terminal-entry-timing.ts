// Original RhineLabUI timing (25 fps), without the previous time compression.
// Scan: footage 19.48–22.76. Welcome: 22.76–26.56, exit to 26.92.
// Array: source app time 21.9–29.1; keep its seconds at 1× speed.
export const ENTRY_TIMING = {
  scan: 3.28,
  opening: 7.08,
  selectionLead: .36,
  selection: 7.56,
  arrayStart: 21.9,
  arrayDuration: 7.2,
} as const;
