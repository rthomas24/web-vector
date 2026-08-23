/** Small helpers shared by the markets capabilities. */

/** `2026-08-22` for a timestamp (UTC calendar day). */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `limit` clamped to [1, max] with a default. */
export function clampLimit(n: number | undefined, def: number, max = 100): number {
  return Math.max(1, Math.min(n ?? def, max));
}

/** 10-digit zero-padded CIK. */
export function padCik(cik: string | number): string {
  return String(cik).replace(/\D/g, '').replace(/^0+/, '').padStart(10, '0');
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `n` weekday dates (UTC) walking back from `now`, as `YYYYMMDD`, newest first. */
export function weekdaysBack(now: number, n: number): string[] {
  const out: string[] = [];
  for (let d = 0; out.length < n && d < n * 2 + 2; d++) {
    const t = new Date(now - d * 86_400_000);
    const dow = t.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(isoDay(t.getTime()).replace(/-/g, ''));
  }
  return out;
}
