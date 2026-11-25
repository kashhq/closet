import { describe, expect, it } from 'vitest';
import {
  activewearGap,
  compareOccasions,
  DEFAULT_OCCASION,
  isOccasion,
  OCCASION_HINTS,
  OCCASIONS,
} from './occasions';
import type { DayForecast } from '../weather/forecast';
import { isActivewearFor, matchGarment, weatherNeeds } from '../weather/match';
import { FORMALITIES } from './properties';

describe('occasions', () => {
  it('are the six of the plan, all day first and the default', () => {
    expect(OCCASIONS).toEqual([
      'all-day',
      'workout',
      'work',
      'daytime',
      'evening',
      'night-out',
    ]);
    expect(DEFAULT_OCCASION).toBe('all-day');
  });

  it('after all day, follow the order their windows start', () => {
    const starts = OCCASIONS.slice(1).map((o) => OCCASION_HINTS[o].window.from);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('each have a window within the day and a formality range on the scale', () => {
    for (const occasion of OCCASIONS) {
      const { window, formality } = OCCASION_HINTS[occasion];
      expect(window.from, occasion).toBeGreaterThanOrEqual(0);
      expect(window.to, occasion).toBeLessThanOrEqual(24);
      expect(window.from, occasion).toBeLessThan(window.to);
      expect(FORMALITIES, occasion).toContain(formality.min);
      expect(FORMALITIES, occasion).toContain(formality.max);
      expect(formality.min, occasion).toBeLessThanOrEqual(formality.max);
    }
  });

  it('carry the plan section 8 defaults: work is at least smart casual, a workout is lounge', () => {
    expect(OCCASION_HINTS.work).toEqual({
      window: { from: 8, to: 18 },
      formality: { min: 3, max: 4 },
    });
    expect(OCCASION_HINTS.evening.window).toEqual({ from: 18, to: 23 });
    expect(OCCASION_HINTS.workout.formality).toEqual({ min: 1, max: 1 });
  });

  it('sort a day into display order, keeping the order of ties', () => {
    const day = [
      { id: 1, occasion: 'evening' as const },
      { id: 2, occasion: 'work' as const },
      { id: 3, occasion: 'all-day' as const },
      { id: 4, occasion: 'evening' as const },
      { id: 5, occasion: 'workout' as const },
    ];
    expect(
      day
        .sort((a, b) => compareOccasions(a.occasion, b.occasion))
        .map((e) => e.id),
    ).toEqual([3, 5, 2, 1, 4]);
  });

  it('recognise only their own values', () => {
    expect(isOccasion('night-out')).toBe(true);
    expect(isOccasion('night out')).toBe(false);
    expect(isOccasion('office')).toBe(false);
    expect(isOccasion('')).toBe(false);
  });
});

describe('activewearGap (#647)', () => {
  const active = OCCASION_HINTS.workout.active!;
  const shoes = { category: 'footwear', type: 'running-shoes' };
  const shorts = { category: 'bottoms', type: 'running-shorts' };
  const jeans = { category: 'bottoms', type: 'jeans' };

  it('says the closet has none when a required kind is missing from it', () => {
    expect(activewearGap(active, [jeans, shoes], [jeans, shoes])).toBe(
      'no-activewear',
    );
  });

  it('says none is available when the closet has them but the pool has not', () => {
    expect(activewearGap(active, [shorts, shoes], [shoes])).toBe(
      'none-available',
    );
  });

  it('says nothing for everyday wear or when activewear is there', () => {
    expect(activewearGap(null, [], [])).toBeUndefined();
    expect(activewearGap(active, [shorts, shoes], [shorts, shoes])).toBe(
      undefined,
    );
  });
});

describe('activewear in a cold snap (#768)', () => {
  const active = OCCASION_HINTS.workout.active!;
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    feelsLike: -20,
    precipitationChance: 0,
    code: 1,
  }));
  const frozen: DayForecast = {
    day: '2026-01-10',
    code: 1,
    high: -18,
    low: -22,
    precipitationChance: 0,
    hours,
  };
  const needs = weatherNeeds(frozen, 'workout', 0);
  const kind = (category: string, type: string) => ({
    category,
    type,
    weather: matchGarment({
      category,
      type,
      fabricWeight: null,
      warmth: null,
      waterResistant: false,
    }),
  });
  const shoes = kind('footwear', 'running-shoes');
  const shorts = kind('bottoms', 'running-shorts');
  const leggings = kind('bottoms', 'leggings');
  const judge = (g: typeof shorts) => isActivewearFor(needs, g);

  it('keeps running shorts out of the judgement, as the pool does', () => {
    expect(judge(shorts)).toBe(false);
    expect(judge(leggings)).toBe(true);
    expect(isActivewearFor(null, shorts)).toBe(true);
  });

  it('says a closet with only running shorts has no activewear for the day', () => {
    const closet = [shorts, shoes];
    expect(activewearGap(active, closet, closet)).toBeUndefined();
    expect(activewearGap(active, closet, closet, judge)).toBe('no-activewear');
  });

  it('is satisfied by warmer activewear, or not available when it is out', () => {
    const closet = [shorts, leggings, shoes];
    expect(activewearGap(active, closet, closet, judge)).toBeUndefined();
    expect(activewearGap(active, closet, [shorts, shoes], judge)).toBe(
      'none-available',
    );
  });
});
