import { describe, expect, it } from 'vitest';
import english from '../i18n/en/lang.json';
import { PLACEHOLDER_KINDS, type StringKey, t } from './i18n';

function entries(node: object, prefix = ''): [string, string][] {
  return Object.entries(node).flatMap(([key, value]) =>
    typeof value === 'string'
      ? [[prefix + key, value] as [string, string]]
      : entries(value as object, `${prefix}${key}.`),
  );
}

const CATALOGUE = new Map(entries(english));
const placeholders = (template: string) =>
  [...template.matchAll(/\{(\w+)\}/g)].map(([, name]) => name).sort();

// A key whose text is only placeholders and punctuation: its output is all
// parameters, so a copy placeholder there is the whole message.
const formatOnly = [...CATALOGUE]
  .filter(
    ([, template]) =>
      placeholders(template).length > 0 &&
      !/\p{L}/u.test(template.replace(/\{\w+\}/g, '')),
  )
  .map(([key]) => key)
  .sort();

describe('PLACEHOLDER_KINDS (#1100)', () => {
  it('classifies every format-only key in the catalogue', () => {
    // The list is the spec's record of the classification: a new format-only
    // key fails here until PLACEHOLDER_KINDS says which placeholders are copy.
    expect(formatOnly).toEqual([
      'CALENDAR_PLAN_DAY',
      'QUANTITY_BADGE',
      'calendar.MONTH_TITLE',
      'calendar.MORE',
      'calendar.SHORT_DAY',
      'calendar.SHORT_DAY_YEAR',
      'calendar.WEEK_RANGE',
      'calendar.WEEK_RANGE_YEARS',
      'care.REPAIR_DAY_VALUE',
      'gallery.PAIR',
      'inspiration.ADD_HINT_PIECE',
      'inspiration.PIECE_NAME',
      'linkImport.REASON_LED',
      'mark.OUTFIT_LABEL',
      'mark.PIECE',
      'muse.round.BOTH',
      'refusal.form.fieldErrors',
      'sizes.BRAND_NOTE',
      'today.push.PLANNED',
      'trips.DATE_RANGE',
      'weather.DAY_HIGH',
      'weather.DAY_RANGE',
      'weather.RANGE',
      'weekPlan.SLOT',
    ]);
    for (const key of formatOnly)
      expect(PLACEHOLDER_KINDS).toHaveProperty([key]);
  });

  it.each(Object.entries(PLACEHOLDER_KINDS))(
    '%s names exactly its placeholders',
    (key, kinds) => {
      expect(Object.keys(kinds).sort()).toEqual(
        placeholders(CATALOGUE.get(key)!),
      );
    },
  );
});

describe('t() parameters (#1100)', () => {
  const copy = t('linkImport.TITLE_ONLY_SEND_NAME');

  it('takes only copy for a copy placeholder', () => {
    expect(
      t('linkImport.REASON_LED', { reason: 'title-only', message: copy }),
    ).toBe(`title-only: ${copy}`);
    // @ts-expect-error a raw string is not copy
    t('linkImport.REASON_LED', { reason: 'title-only', message: 'Try again' });
    const raw: string = 'Required';
    // @ts-expect-error nor is a string variable
    t('refusal.form.fieldErrors', { field: 'name', errors: raw });
    // @ts-expect-error a listed key's placeholders are required
    expect(() => t('muse.round.BOTH')).toThrow('missing parameter');
  });

  it('takes any string or number for a data placeholder', () => {
    const name: string = 'Linen shirt';
    expect(t('gallery.PAIR', { a: name, b: 'Boots' })).toBe(
      'Linen shirt + Boots',
    );
    expect(t('QUANTITY_BADGE', { quantity: 3 })).toBe('×3');
    expect(t('mark.PIECE', { name, marks: copy })).toBe(`${name} (${copy})`);
    expect(t('wear.DAYS_AGO', { days: 3 })).toBe('3 days ago');
  });

  it('fails closed for a key type wider than one key', () => {
    const key = 'linkImport.REASON_LED' as StringKey;
    // @ts-expect-error a wide key may be a format-only one: its copy stays copy
    t(key, { reason: 'title-only', message: 'Try again' });
    const label = (either: 'gallery.PAIR' | 'weekPlan.SLOT') =>
      // @ts-expect-error a union takes what every key in it takes
      t(either, { a: 'x', b: 'y', day: 'Monday', occasion: 'evening' });
    expect(label).toBeTypeOf('function');
  });
});
