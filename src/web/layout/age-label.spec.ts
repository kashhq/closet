import { describe, expect, it } from 'vitest';
// The freshness indicator's wording runs in the browser; its pure part is
// tested here.
import {
  ageLabel,
  ageParts,
  STALE_AFTER_MS,
} from '../../../views/assets/page/age-label';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('ageParts', () => {
  it('has nothing to say under a minute, or for a clock set back', () => {
    expect(STALE_AFTER_MS).toBe(MINUTE);
    expect(ageParts(0)).toBeNull();
    expect(ageParts(59 * SECOND)).toBeNull();
    expect(ageParts(-5 * MINUTE)).toBeNull();
    expect(ageParts(Number.NaN)).toBeNull();
  });

  it('takes the largest whole unit, rounding down', () => {
    expect(ageParts(MINUTE)).toEqual({ value: 1, unit: 'minute' });
    expect(ageParts(59 * MINUTE + 59 * SECOND)).toEqual({
      value: 59,
      unit: 'minute',
    });
    expect(ageParts(HOUR)).toEqual({ value: 1, unit: 'hour' });
    expect(ageParts(23 * HOUR + 59 * MINUTE)).toEqual({
      value: 23,
      unit: 'hour',
    });
    expect(ageParts(DAY)).toEqual({ value: 1, unit: 'day' });
    expect(ageParts(45 * DAY + 3 * HOUR)).toEqual({ value: 45, unit: 'day' });
  });
});

describe('ageLabel', () => {
  it.each([
    [30 * SECOND, null],
    [MINUTE, '1 minute ago'],
    [3 * MINUTE + 20 * SECOND, '3 minutes ago'],
    [2 * HOUR + 5 * MINUTE, '2 hours ago'],
    [DAY + HOUR, 'yesterday'],
    [3 * DAY, '3 days ago'],
  ])('says %i ms is %s', (ageMs, label) => {
    expect(ageLabel(ageMs, 'en')).toBe(label);
  });
});
