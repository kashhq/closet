import { describe, expect, it } from 'vitest';
import {
  guessColors,
  guessFabricWeight,
  guessKind,
  guessMaterials,
  guessWeightWarmth,
} from './guess';

describe('guessColors', () => {
  it.each([
    ['Navy', ['blue']],
    ['Heather Grey', ['grey']],
    ['Off-White', ['white']],
    ['Olive / Black', ['green', 'black']],
    ['Burgundy', ['red']],
    ['Camel', ['beige']],
    ['Navy/White Stripe', ['blue', 'white', 'pattern']],
    ['Multicolor', ['pattern']],
    ['CHARCOAL', ['grey']],
  ])('%s is %j', (text, colors) => {
    expect(guessColors(text)).toEqual(colors);
  });

  it.each([
    'Tank Top',
    'Sandals',
    'Standard Fit',
    'Ashford Shirt',
    'Pocket Tee',
    '',
  ])('finds none in %j (whole words only)', (text) => {
    expect(guessColors(text)).toEqual([]);
  });
});

describe('guessKind', () => {
  it.each([
    ['Organic Cotton T-Shirt', 'tops', 't-shirt'],
    ['Heavyweight Pocket Tee – Navy', 'tops', 't-shirt'],
    ['Long Sleeve Tee', 'tops', 'long-sleeve-tee'],
    ['Oxford Button-Down Shirt', 'tops', 'shirt'],
    ['Dress Shirt', 'tops', 'shirt'],
    ['Shirt Dress', 'dresses', 'day-dress'],
    ['Linen Shirt Dress', 'dresses', 'day-dress'],
    ['Fleece Hoodie', 'tops', 'hoodie'],
    ['Polar Fleece Jacket', 'outerwear', 'fleece'],
    ['Crewneck Sweatshirt', 'tops', 'sweatshirt'],
    ['Merino Crew Sweater', 'tops', 'sweater'],
    ['Selvedge Jeans 14 oz', 'bottoms', 'jeans'],
    ['Boot Cut Jeans', 'bottoms', 'jeans'],
    ['Pleated Wool Trousers', 'bottoms', 'trousers'],
    ['Classic Sweatpants', 'bottoms', 'sweatpants'],
    ['Trucker Jacket', 'outerwear', 'denim-jacket'],
    ['Denim Jacket', 'outerwear', 'denim-jacket'],
    ['Waxed Cotton Jacket', 'outerwear', 'jacket'],
    ['Down Puffer Jacket', 'outerwear', 'puffer'],
    ['Wool Overcoat', 'outerwear', 'coat'],
    ['Leather Chelsea Boots', 'footwear', 'boots'],
    ['Suede Loafers', 'footwear', 'loafers'],
    ['Leather Dress Shoes', 'footwear', 'dress-shoes'],
    ['Canvas Shoes', 'footwear', null],
    ['Ribbed Beanie', 'accessories', 'beanie'],
    ['Leather Belt Bag', 'bags', null],
    ['Canvas Tote Bag', 'bags', 'tote'],
    ['Crop Top', 'tops', null],
    // The everyday types (#685): a sock, swim trunks over shorts.
    ["Men's Calf Sock 6-Pack", 'accessories', 'socks'],
    ['Cotton Boxer Briefs 3-Pack', 'accessories', 'underwear'],
    ['6" Stretch Swim Trunk', 'bottoms', 'swimwear'],
    ['Swim Shorts', 'bottoms', 'swimwear'],
    ['One-Piece Swimsuit', 'dresses', 'swimwear'],
    ['Flannel Pajama Pants', 'bottoms', 'sleepwear'],
    ['Running Shorts 5"', 'bottoms', 'running-shorts'],
    ['DRY-EX Running Tee', 'tops', 'sports-top'],
    // Sleeveless sports tops are tanks, not short-sleeved sports tops (#765).
    ['High-Support Sports Bra', 'tops', 'tank'],
    ['Seamless Gym Tank', 'tops', 'tank'],
    ['Running Tank Top', 'tops', 'tank'],
    ['Race Singlet', 'tops', 'tank'],
  ])('%s is %s / %s', (text, category, type) => {
    expect(guessKind(text)).toEqual({ category, type });
  });

  it.each(['Gift Card', 'Acme Supply', ''])('finds nothing in %j', (text) => {
    expect(guessKind(text)).toBeNull();
  });
});

describe('guessMaterials', () => {
  it.each([
    ['100% organic cotton jersey', ['cotton']],
    ['Merino wool', ['merino']],
    ['70% wool, 30% cashmere', ['wool', 'cashmere']],
    ['Raw selvedge denim', ['denim']],
    ['Faux leather', ['synthetic']],
    ['Vegan leather upper, leather lining', ['leather', 'synthetic']],
    ['Faux-leather jacket', ['synthetic']],
    ['PU-leather belt', ['synthetic']],
    ['Vegan‑leather tote', ['synthetic']],
    ['Leather-trimmed tote', ['leather']],
    ['Filled with 700-fill goose down', ['down']],
    ['Oxford button-down shirt', []],
    ['Shell: nylon; lining: polyester', ['polyester', 'nylon']],
  ])('%s is %j', (text, materials) => {
    expect(guessMaterials(text)).toEqual(materials);
  });
});

describe('guessFabricWeight', () => {
  it.each([
    ['240 gsm cotton jersey', 240],
    ['Heavy 240gsm tee', 240],
    ['Weight: 300 g/m2', 300],
    ['A 14 oz selvedge denim', 475],
    ['14oz denim', 475],
    ['6-ounce jersey', 203],
    ['13.5 oz. denim', 458],
  ])('%s is %i gsm', (text, gsm) => {
    expect(guessFabricWeight(text)).toBe(gsm);
  });

  it.each([
    'Heavyweight tee',
    'Size 14',
    '5000 gsm',
    '0.1 oz',
    'Ounces of prevention',
  ])('finds none in %j', (text) => {
    expect(guessFabricWeight(text)).toBeNull();
  });
});

describe('guessWeightWarmth', () => {
  it('takes the heaviest step for "heavyweight"', () => {
    expect(guessWeightWarmth('Heavyweight Tee', 'tops', 't-shirt')).toBe(3);
    expect(guessWeightWarmth('Heavy-weight jeans', 'bottoms', 'jeans')).toBe(4);
  });

  it('takes the lightest step for "lightweight"', () => {
    expect(guessWeightWarmth('Lightweight Tee', 'tops', 't-shirt')).toBe(1);
  });

  it('has nothing to say for a type without weight steps, or no words', () => {
    expect(
      guessWeightWarmth('Heavyweight Sweater', 'tops', 'sweater'),
    ).toBeNull();
    expect(guessWeightWarmth('Pocket Tee', 'tops', 't-shirt')).toBeNull();
    expect(guessWeightWarmth('Heavyweight bag', 'bags', null)).toBeNull();
  });
});
