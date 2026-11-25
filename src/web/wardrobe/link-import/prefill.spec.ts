import { describe, expect, it } from 'vitest';
import { GarmentCategory } from '../../../wardrobe/properties';
import { t } from '../../i18n';
import type { ExtractedProduct } from './extract';
import { linkIn } from './link-text';
import { BLANK_GARMENT_VALUES } from '../garment-input';
import { importedForm } from './prefill';

const LINK = 'https://shop.test/p/tee';

const product = (fields: Partial<ExtractedProduct>): ExtractedProduct => ({
  source: 'json-ld',
  confidence: 'product',
  name: null,
  brand: null,
  price: null,
  colors: [],
  category: null,
  type: null,
  materials: [],
  fabricWeight: null,
  warmth: null,
  sleeve: null,
  images: [],
  ...fields,
});

describe('linkIn', () => {
  it.each([
    [LINK, LINK],
    [`  ${LINK}  `, LINK],
    [`Heavy tee | Studio Knit ${LINK}`, LINK],
    [`Look at this (${LINK}).`, LINK],
    [`"${LINK}"`, LINK],
    ['HTTP://SHOP.TEST/P', 'HTTP://SHOP.TEST/P'],
    [`${LINK}?color=navy&size=m, and more`, `${LINK}?color=navy&size=m`],
  ])('finds the link in %j', (text, link) => {
    expect(linkIn(text)).toBe(link);
  });

  it.each(['', 'just words', 'ftp://shop.test/x', 'shop.test/p/tee'])(
    'finds none in %j',
    (text) => {
      expect(linkIn(text)).toBeUndefined();
    },
  );
});

describe('importedForm', () => {
  it('prefills a product page, presets filled where the page said nothing', () => {
    const { values, link } = importedForm(
      {
        kind: 'page',
        product: product({
          name: 'Heavyweight Pocket Tee',
          brand: 'Studio Knit',
          price: { amount: '48.00', currency: 'USD' },
          colors: ['blue'],
          category: GarmentCategory.TOPS,
          type: 't-shirt',
          materials: ['cotton'],
          fabricWeight: 240,
        }),
        photo: 'photo.webp',
        choices: [],
      },
      LINK,
    );
    expect(values).toMatchObject({
      name: 'Heavyweight Pocket Tee',
      brand: 'Studio Knit',
      category: 'tops',
      colors: ['blue'],
      sourceUrl: LINK,
      price: '48.00',
      properties: {
        type: 't-shirt',
        materials: ['cotton'],
        fabricWeight: '240',
        fabricWeightUnit: 'gsm',
        // The tee's presets, as choosing it by hand would fill them.
        sleeve: 'short',
        preset: { category: 'tops', type: 't-shirt', weight: '240' },
      },
    });
    expect(values.properties.warmth).not.toBe('');
    expect(link).toEqual({
      photo: 'photo.webp',
      choices: [],
      notices: [t('linkImport.FOUND_DETAILS')],
      warnings: [],
    });
  });

  it('keeps a stated warmth over the preset', () => {
    const { values } = importedForm(
      {
        kind: 'page',
        product: product({
          category: GarmentCategory.TOPS,
          type: 't-shirt',
          warmth: 1,
        }),
        photo: undefined,
        choices: [],
      },
      LINK,
    );
    expect(values.properties.warmth).toBe('1');
  });

  it.each([
    [
      'a named sleeve over the type preset',
      'sleeveless' as const,
      'sleeveless',
    ],
    ['the type preset when the page named none', null, 'short'],
  ])('a sports top takes %s (#765)', (_label, sleeve, expected) => {
    const { values } = importedForm(
      {
        kind: 'page',
        product: product({
          category: GarmentCategory.TOPS,
          type: 'sports-top',
          sleeve,
        }),
        photo: undefined,
        choices: [],
      },
      LINK,
    );
    expect(values.properties.sleeve).toBe(expected);
  });

  it('takes a price without a currency as dollars and leaves any other currency', () => {
    const priced = (currency: string | null) =>
      importedForm(
        {
          kind: 'page',
          product: product({ price: { amount: '1299.00', currency } }),
          photo: undefined,
          choices: [],
        },
        LINK,
      );
    expect(priced(null).values.price).toBe('1299.00');
    expect(priced('USD').values.price).toBe('1299.00');
    const sek = priced('SEK');
    expect(sek.values.price).toBe('');
    expect(sek.link.notices).toEqual([
      t('linkImport.FOUND_DETAILS'),
      t('linkImport.NO_PHOTO'),
      t('linkImport.PRICE_CURRENCY', { currency: 'SEK' }),
    ]);
  });

  it('says when nothing was found, keeping only the link', () => {
    const { values, link } = importedForm(
      {
        kind: 'page',
        product: product({ source: null, confidence: 'title-only' }),
        photo: undefined,
        choices: [],
      },
      LINK,
    );
    expect(values.name).toBe('');
    expect(values.sourceUrl).toBe(LINK);
    expect(link.warnings).toEqual([t('linkImport.NOTHING_FOUND')]);
    expect(link.notices).toEqual([]);
  });

  it('keeps only the link of a title-only read, with a warning, not the success notice', () => {
    const { values, link } = importedForm(
      {
        kind: 'page',
        product: product({
          source: 'title',
          confidence: 'title-only',
          name: 'The Worlds Most Comfortable Shoes',
          brand: 'Shop',
          category: GarmentCategory.FOOTWEAR,
          colors: ['blue'],
        }),
        photo: undefined,
        choices: [],
      },
      LINK,
    );
    expect(values).toEqual({ ...BLANK_GARMENT_VALUES, sourceUrl: LINK });
    expect(link.warnings).toEqual([t('linkImport.TITLE_ONLY')]);
    expect(link.notices).toEqual([]);
  });

  it('opens an image link with its photo and blank fields', () => {
    const { values, link } = importedForm(
      { kind: 'image', photo: 'photo.webp' },
      'https://cdn.shop.test/tee.jpg',
    );
    expect(values.sourceUrl).toBe('');
    expect(values.name).toBe('');
    expect(link).toEqual({
      photo: 'photo.webp',
      choices: [],
      notices: [t('linkImport.PHOTO_ONLY')],
      warnings: [],
    });
  });
});
