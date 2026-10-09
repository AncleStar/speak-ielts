export const reviewIntervalDays = (count: number) => [1, 3, 7, 14][Math.min(Math.max(count - 1, 0), 3)];
