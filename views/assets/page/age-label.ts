/**
 * How old a page on screen is, in words: "3 minutes ago", "yesterday".
 * Pure, for freshness.ts (and its unit spec,
 * src/web/layout/age-label.spec.ts).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Younger than this, a copy is as good as live: no indicator. */
export const STALE_AFTER_MS = MINUTE;

/**
 * The largest whole unit of an age, or null under a minute (and for a
 * negative age, from a clock set back).
 */
export function ageParts(
  ageMs: number,
): { value: number; unit: 'day' | 'hour' | 'minute' } | null {
  if (!(ageMs >= STALE_AFTER_MS)) return null;
  if (ageMs >= DAY) return { value: Math.floor(ageMs / DAY), unit: 'day' };
  if (ageMs >= HOUR) return { value: Math.floor(ageMs / HOUR), unit: 'hour' };
  return { value: Math.floor(ageMs / MINUTE), unit: 'minute' };
}

/** Null while the age is under a minute; `locale` is the document's language. */
export function ageLabel(ageMs: number, locale: string): string | null {
  const parts = ageParts(ageMs);
  if (!parts) return null;
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
    -parts.value,
    parts.unit,
  );
}
