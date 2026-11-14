import { describe, expect, it } from 'vitest';
import {
  categoryLabel,
  categorySuggestions,
  compareSizes,
  normalizeCategory,
  normalizeSize,
  orderCategories,
} from './garment';
import { isGarmentColor } from '../../wardrobe/properties';

describe('garment fields', () => {
  it('orders built-in categories as the enum does, custom ones after, sorted', () => {
    expect(
      orderCategories(['hats', 'footwear', 'belts', 'outerwear', 'tops']),
    ).toEqual(['outerwear', 'tops', 'footwear', 'belts', 'hats']);
  });

  it('suggests every built-in category once, then the wardrobe’s own', () => {
    expect(categorySuggestions(['tops', 'hats'])).toEqual([
      'accessories',
      'bags',
      'outerwear',
      'dresses',
      'tops',
      'bottoms',
      'footwear',
      'other',
      'hats',
    ]);
  });

  it('stores categories trimmed and lower case, and labels built-in ones in words', () => {
    expect(normalizeCategory('  Tops ')).toBe('tops');
    expect(normalizeCategory('OUTERWEAR')).toBe('outerwear');
    expect(categoryLabel('tops')).toBe('Tops');
    expect(categoryLabel('hats')).toBe('hats');
  });

  it.each([
    ['m', 'Medium'],
    [' X-large ', 'X-Large'],
    ['xl', 'X-Large'],
    ['2XL', 'XX-Large'],
    ['5xl', '5X-Large'],
    ['xxs', 'XX-Small'],
    ['32', '32'],
    [' One Size ', 'One Size'],
  ])('normalizes size %j to %j', (input, expected) => {
    expect(normalizeSize(input)).toBe(expected);
  });

  it('has no size for a blank one', () => {
    expect(normalizeSize('   ')).toBeUndefined();
  });

  it('sorts letter sizes in wearing order, custom ones after', () => {
    expect(
      ['32', 'Large', 'X-Small', '5X-Large', 'One Size', 'XX-Large'].sort(
        compareSizes,
      ),
    ).toEqual(['X-Small', 'Large', 'XX-Large', '5X-Large', '32', 'One Size']);
  });

  it('knows only the built-in colours', () => {
    expect(isGarmentColor('red')).toBe(true);
    for (const value of ['Red', 'crimson', '<img src=x>', '', 'red,blue']) {
      expect(isGarmentColor(value)).toBe(false);
    }
  });
});
