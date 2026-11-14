import { describe, expect, it } from 'vitest';
import { relativeDay } from './web/date-labels';
import {
  BodyArrivals,
  dayOfStamp,
  dayText,
  pageDay,
  wearQueuesOn,
  wearRowFlips,
  wornState,
} from './page-day';

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

describe('pageDay', () => {
  const arrivedAt = Date.UTC(2026, 5, 11, 3, 30); // 23:30 on the 10th in New York

  it('is the stamp’s day when the copy has one', () => {
    expect(pageDay(String(Date.UTC(2026, 5, 8, 15)), arrivedAt, NEW_YORK)).toBe(
      '2026-06-08',
    );
  });

  // No service worker (the HTTP twin, PWA_ENABLED off): freshness.js never
  // stamps the page, which is then of its body's arrival.
  it.each([undefined, '', 'soon'])(
    'is the arrival’s household day without a stamp (%j)',
    (stamp) => {
      expect(pageDay(stamp, arrivedAt, NEW_YORK)).toBe('2026-06-10');
    },
  );
});

describe('BodyArrivals', () => {
  const MONDAY = Date.UTC(2026, 5, 8, 15);
  const THURSDAY = Date.UTC(2026, 5, 11, 15);

  // A tab left open for days (#990): a boosted navigation never reloads the
  // document, so its load is no later page's day.
  it('is the last boosted navigation’s arrival, not the document’s load', () => {
    const arrivals = new BodyArrivals('/', MONDAY);
    arrivals.arrived('/wardrobe/41', THURSDAY);
    expect(arrivals.current).toBe(THURSDAY);
  });

  it('gives a restored snapshot its own arrival, and a pushed URL its body’s', () => {
    const arrivals = new BodyArrivals('/', MONDAY);
    arrivals.pushed('/?capsule=3'); // a fragment's URL, Monday's body
    arrivals.arrived('/wardrobe/41', THURSDAY);
    arrivals.restored('/');
    expect(arrivals.current).toBe(MONDAY);
    arrivals.restored('/wardrobe/41');
    arrivals.restored('/?capsule=3');
    expect(arrivals.current).toBe(MONDAY);
  });

  it('keeps the current arrival for a snapshot it never saw', () => {
    const arrivals = new BodyArrivals('/', MONDAY);
    arrivals.arrived('/wardrobe/41', THURSDAY);
    arrivals.restored('/elsewhere');
    expect(arrivals.current).toBe(THURSDAY);
  });
});

describe('wearQueuesOn', () => {
  it('queues the page’s row, judged on the tap’s day, whatever the copy’s day', () => {
    expect(wearQueuesOn(undefined, '2026-06-11')).toBe(true);
  });

  it('refuses a live answer of another day: left open overnight', () => {
    expect(wearQueuesOn('2026-06-11', '2026-06-11')).toBe(true);
    expect(wearQueuesOn('2026-06-10', '2026-06-11')).toBe(false);
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
  it('is the last wear’s kind only on the day judged', () => {
    expect(wornState('2026-06-10', 'single', '2026-06-10')).toBe('single');
    expect(wornState('2026-06-10', 'entry', '2026-06-10')).toBe('entry');
    expect(wornState('2026-06-10', 'single', '2026-06-11')).toBe('unworn');
    expect(wornState(undefined, undefined, '2026-06-11')).toBe('unworn');
    expect(wornState('2026-06-11', 'other', '2026-06-11')).toBe('unworn');
  });
});

// What showPageDay does to a Wore today row (views/assets/outbox.ts): the
// server renders Wore today shown and its undo in the template; the row
// flips when what it shows is not its state.
describe('wearRowFlips', () => {
  it('flips the server’s Wore today to the undo after a single wear', () => {
    expect(wearRowFlips('single', false, false)).toBe(true);
    expect(wearRowFlips('single', true, false)).toBe(false);
  });

  it('flips a shown undo back once the day is not the wear’s', () => {
    expect(wearRowFlips('unworn', true, false)).toBe(true);
    expect(wearRowFlips('unworn', false, false)).toBe(false);
    // The badge's state: the row is hidden, its Wore today unflipped.
    expect(wearRowFlips('entry', false, false)).toBe(false);
  });

  it('reads a row showing a queued intent as the server’s other state', () => {
    // Wore today queued offline: the undo shows, the server's state is unworn.
    expect(wearRowFlips('unworn', true, true)).toBe(false);
    expect(wearRowFlips('single', true, true)).toBe(true);
  });
});
