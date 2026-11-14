import { describe, expect, it } from 'vitest';
import { relativeDay } from './web/date-labels';
import { dayOfStamp, dayText, wearQueuesOn, wornState } from './page-day';

const NEW_YORK = 'America/New_York';

describe('dayOfStamp', () => {
  it('is the household date of the stamp, a New York evening included', () => {
    // 23:30 in New York, already the next day in UTC.
    expect(dayOfStamp(String(Date.UTC(2026, 5, 11, 3, 30)), NEW_YORK)).toBe(
      '2026-06-10',
    );
  });

  it.each([undefined, '', 'NaN', 'soon', '0', '-5'])(
    'knows no day for a stamp of %j',
    (stamp) => {
      expect(dayOfStamp(stamp, NEW_YORK)).toBeUndefined();
    },
  );
});

describe('wearQueuesOn', () => {
  it('queues only from a page of the tap’s day, never one of no day', () => {
    expect(wearQueuesOn('2026-06-10', '2026-06-10')).toBe(true);
    // A page left open overnight: its day is the stamp's, the tap's moved on.
    expect(wearQueuesOn('2026-06-10', '2026-06-11')).toBe(false);
    expect(wearQueuesOn(dayOfStamp('soon', NEW_YORK), '2026-06-11')).toBe(
      false,
    );
  });
});

describe('dayText', () => {
  // The server's words for the same days (date-labels.ts), so the client's
  // reading of a page is what the server used to render.
  it.each([
    ['2026-06-10', '2026-06-10'],
    ['2026-06-09', '2026-06-10'],
    ['2026-06-04', '2026-06-10'],
    ['2026-06-03', '2026-06-10'],
    ['2025-12-30', '2026-01-02'],
  ])('words %s on %s as relativeDay does', (day, pageDay) => {
    expect(dayText(day, pageDay, 'relative', 'en')).toBe(
      relativeDay(day, pageDay),
    );
  });

  it('words a date without its relative form', () => {
    expect(dayText('2026-06-09', '2026-06-10', 'date', 'en')).toBe(
      'Tue, Jun 9',
    );
  });
});

describe('wornState', () => {
  it('is the last wear’s kind only on the page’s day', () => {
    expect(wornState('2026-06-10', 'single', '2026-06-10')).toBe('single');
    expect(wornState('2026-06-10', 'entry', '2026-06-10')).toBe('entry');
    expect(wornState('2026-06-10', 'single', '2026-06-11')).toBe('unworn');
    expect(wornState(undefined, undefined, '2026-06-11')).toBe('unworn');
    expect(wornState('2026-06-11', 'other', '2026-06-11')).toBe('unworn');
  });
});
