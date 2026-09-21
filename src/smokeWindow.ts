const FUTURE_BUFFER_MS = 5 * 60 * 1000;

/** Calendly requires availability start_time to be strictly in the future. */
export function isoRangeDays(
  days: number,
  now: () => number = Date.now,
  futureBufferMs = FUTURE_BUFFER_MS,
): { start: string; end: string } {
  const start = new Date(now() + futureBufferMs);
  const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}
