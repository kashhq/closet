import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ExtractedProduct,
  extractProduct,
  MAX_IMAGE_CANDIDATES,
  parsePrice,
} from './extract';

const fixture = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8');

const NOTHING: ExtractedProduct = {
  source: null,
  confidence: 'title-only',
  name: null,
  brand: null,
  price: null,
  colors: [],
  category: null,
  type: null,
  materials: [],
  fabricWeight: null,
  warmth: null,
  images: [],
};

const page = (head: string) => `<html><head>${head}</head></html>`;

describe('extractProduct', () => {
  it('reads a Shopify product page from its ProductGroup JSON-LD', () => {
    const page = new URL(
      'https://acme-supply.test/products/heavyweight-pocket-tee?variant=4401',
    );

    expect(extractProduct(fixture('shopify-product.html'), page)).toEqual({
      source: 'json-ld',
      confidence: 'product',
      name: 'Heavyweight Pocket Tee – Navy',
      brand: 'Acme Supply Co.',
      // On the variant only, as Shopify writes it.
      price: { amount: '48.00', currency: 'USD' },
      colors: ['blue'],
      category: 'tops',
      type: 't-shirt',
      materials: ['cotton'],
      fabricWeight: 240,
      // A stated weight leaves warmth to the form's presets.
      warmth: null,
      images: [
        'https://acme-supply.test/cdn/shop/files/pocket-tee-navy-front.jpg?v=1712345678&width=1920',
        'https://acme-supply.test/cdn/shop/files/pocket-tee-navy-back.jpg?v=1712345678&width=1920',
        'https://acme-supply.test/cdn/shop/files/pocket-tee-navy-front.jpg?v=1712345678',
        'http://acme-supply.test/cdn/shop/files/pocket-tee-navy-front.jpg?v=1712345678',
      ],
    });
  });

  it('finds the Product in an @graph, repairing a raw newline in a string', () => {
    const page = new URL('https://irondenim.test/produkt/selvedge-jeans/');

    expect(extractProduct(fixture('woocommerce-graph.html'), page)).toEqual({
      source: 'json-ld',
      confidence: 'product',
      name: 'Selvedge Jeans 14 oz',
      brand: 'Iron Denim',
      price: { amount: '1299.00', currency: 'SEK' },
      colors: ['blue'],
      category: 'bottoms',
      type: 'jeans',
      materials: ['cotton', 'denim'],
      fabricWeight: 475,
      warmth: null,
      images: [
        'https://irondenim.test/wp-content/uploads/2026/03/selvedge-jeans.jpg',
      ],
    });
  });

  it('falls back to Open Graph, resolving images against <base href>', () => {
    const page = new URL('https://knitwear.test/products/merino-crew');

    expect(extractProduct(fixture('open-graph-only.html'), page)).toEqual({
      source: 'open-graph',
      confidence: 'product',
      name: 'Merino Crew Sweater',
      brand: 'Knitwear Co.',
      price: { amount: '120', currency: 'EUR' },
      colors: ['grey'],
      category: 'tops',
      type: 'sweater',
      materials: ['merino'],
      fabricWeight: null,
      warmth: null,
      images: [
        'https://cdn.knitwear.test/assets/images/merino-crew-charcoal.jpg',
        'https://cdn.knitwear.test/assets/images/merino-crew-detail.jpg',
      ],
    });
  });

  it('falls back to <title> without the site name', () => {
    const html =
      '<html><head><title>Linen Shirt Dress | Boutique</title></head></html>';

    expect(extractProduct(html, new URL('https://boutique.test/p/1'))).toEqual({
      ...NOTHING,
      source: 'title',
      confidence: 'title-only',
      name: 'Linen Shirt Dress',
      brand: 'Boutique',
      category: 'dresses',
      type: 'day-dress',
      materials: ['linen'],
    });
  });

  describe('confidence', () => {
    const jsonLd = `<script type="application/ld+json">{"@type":"Product","name":"Wool Coat","brand":"Acme"}</script>`;
    const ogOnly =
      '<meta property="og:title" content="Acme Outerwear"><meta property="og:image" content="/logo.png">';
    const appShell =
      '<html><head><title>Acme</title></head><body><div id="root"></div></body></html>';
    const product = new URL('https://acme.test/p/wool-coat-123');

    it.each([
      ['a JSON-LD Product', page(jsonLd), 'product'],
      [
        'Open Graph with product tags',
        page(`${ogOnly}<meta property="product:price:amount" content="9">`),
        'product',
      ],
      [
        'Open Graph typed as a product',
        page(`${ogOnly}<meta property="og:type" content="product">`),
        'product',
      ],
      ['Open Graph alone', page(ogOnly), 'page'],
      ['an app shell with only a title', appShell, 'title-only'],
      ['an empty page', '', 'title-only'],
    ] as const)('is read from %s', (_, html, confidence) => {
      expect(extractProduct(html, product).confidence).toBe(confidence);
    });

    it('is title-only when the link was redirected to the home page, whatever it says', () => {
      const home = new URL('https://acme.test/');
      expect(extractProduct(page(jsonLd), home, product).confidence).toBe(
        'title-only',
      );
      for (const landing of [
        'https://acme.test/en-us/',
        'https://acme.test/us',
      ]) {
        expect(
          extractProduct(page(jsonLd), new URL(landing), product).confidence,
        ).toBe('title-only');
      }
      // Another host's root: a consent or tracking redirect that ended at a home page.
      expect(
        extractProduct(page(jsonLd), new URL('https://www.acme.test/'), product)
          .confidence,
      ).toBe('title-only');
    });

    it('stays product when a shop tidies the address: a canonical redirect to an ancestor', () => {
      const asked = new URL('https://acme.test/product/123/wool-coat');
      for (const final of [
        'https://acme.test/product/123',
        'https://acme.test/product',
        'https://acme.test/en-us/product/123',
      ]) {
        expect(
          extractProduct(page(jsonLd), new URL(final), asked).confidence,
        ).toBe('product');
      }
    });

    it('keeps a null brand on a product read, the shop standing in only below it', () => {
      const store = new URL('https://www.nordstrom.test/p/1');
      expect(
        extractProduct(
          page(
            '<script type="application/ld+json">{"@type":"Product","name":"Wool Coat"}</script><meta property="og:site_name" content="Nordstrom">',
          ),
          store,
        ),
      ).toMatchObject({ confidence: 'product', brand: null });
      expect(
        extractProduct(
          page(
            '<meta property="og:title" content="Wool Coat"><meta property="og:site_name" content="Nordstrom">',
          ),
          store,
        ),
      ).toMatchObject({ confidence: 'page', brand: 'Nordstrom' });
    });

    it('is not lowered by a redirect that stayed as deep as the link was', () => {
      const locale = new URL('https://acme.test/us/p/wool-coat-123');
      expect(extractProduct(page(jsonLd), locale, product).confidence).toBe(
        'product',
      );
    });

    it('is not lowered when the link itself was the home page', () => {
      const home = new URL('https://acme.test/');
      expect(extractProduct(page(jsonLd), home).confidence).toBe('product');
    });
  });

  it('strips the site from a title and takes the brand from og:site_name', () => {
    const html = page(
      '<title>Mens Merino Sweater | UNIQLO US</title><meta property="og:site_name" content="UNIQLO">',
    );
    expect(
      extractProduct(html, new URL('https://www.uniqlo.com/us/p/1')),
    ).toMatchObject({ name: 'Mens Merino Sweater', brand: 'UNIQLO' });
  });

  it('strips a title suffix only when it is the site, so a variant stays', () => {
    // The Shopify fixture's own <title>: "Heavyweight Pocket Tee – Navy –
    // Acme Supply Co." loses only the site, and its og:site_name names it.
    const shopify = fixture('shopify-product.html')
      .replace(/<script type="application\/ld\+json"[\s\S]*?<\/script>/g, '')
      .replace(/<meta property="og:title"[^>]*>/g, '');
    expect(
      extractProduct(
        shopify,
        new URL('https://acme-supply.test/products/heavyweight-pocket-tee'),
      ).name,
    ).toBe('Heavyweight Pocket Tee – Navy');
    const variant = page(
      '<title>Pocket Tee – Navy</title><meta property="og:title" content="Pocket Tee – Navy"><meta property="og:site_name" content="Acme Supply Co.">',
    );
    const url = new URL('https://acme-supply.test/products/pocket-tee');
    expect(extractProduct(variant, url).name).toBe('Pocket Tee – Navy');
    const branded = page(
      '<meta property="og:title" content="Pocket Tee – Navy | Acme Supply Co.">' +
        '<meta property="og:site_name" content="Acme Supply Co.">',
    );
    expect(extractProduct(branded, url).name).toBe('Pocket Tee – Navy');
    // The domain's own name counts when the page gives no og:site_name.
    expect(
      extractProduct(page('<title>Pocket Tee | Acme-supply</title>'), url).name,
    ).toBe('Pocket Tee');
  });

  it.each([
    ['https://www.uniqlo.com/p/1', 'Uniqlo'],
    ['https://shop.example.co.uk/p/1', 'Example'],
    ['http://127.0.0.2/p/1', null],
    // A shop on a hosting platform is its subdomain, never the platform (#799).
    ['https://acme.myshopify.com/products/tee', 'Acme'],
    ['https://shop.acme.myshopify.com/products/tee', 'Acme'],
    ['https://acme-goods.squarespace.com/shop/tee', 'Acme-goods'],
    ['https://myshopify.com/', null],
  ])('falls back from a missing brand to the domain: %s', (url, brand) => {
    const html = page('<title>Tee | Shop</title>');
    expect(extractProduct(html, new URL(url)).brand).toBe(brand);
  });

  it('reads a colour from the address when the page names none', () => {
    const html = page(
      '<meta property="og:title" content="Merino Crew Sweater">',
    );
    expect(
      extractProduct(html, new URL('https://k.test/p/merino-crew-navy.html'))
        .colors,
    ).toEqual(['blue']);
    expect(
      extractProduct(html, new URL('https://k.test/p/merino-crew?Color=Olive'))
        .colors,
    ).toEqual(['green']);
    expect(
      extractProduct(html, new URL('https://k.test/p/merino-crew?color=olive'))
        .colors,
    ).toEqual(['green']);
  });

  it('keeps a product read without a colour when the address names a brand or style', () => {
    const html = page(
      '<meta property="og:title" content="Iron Ranger"><meta property="product:brand" content="Red Wing">',
    );
    const read = extractProduct(
      html,
      new URL('https://k.test/p/red-wing-boots'),
    );

    expect(read.confidence).toBe('product');
    expect(read.colors).toEqual([]);
    const ld = `<script type="application/ld+json">{"@type":"Product","name":"Flannel Shirt"}</script>`;
    expect(
      extractProduct(ld, new URL('https://k.test/p/blackwatch-plaid')).colors,
    ).toEqual([]);
  });

  it('reads an explicit colour parameter even on a product read', () => {
    const html = page(
      '<meta property="og:title" content="Iron Ranger"><meta property="product:brand" content="Red Wing">',
    );
    const read = extractProduct(
      html,
      new URL('https://k.test/p/red-wing-boots?Color=Olive'),
    );

    expect(read.confidence).toBe('product');
    expect(read.colors).toEqual(['green']);
  });

  it('finds nothing on a page without any of it', () => {
    const html = '<html><body><h1>Access denied</h1></body></html>';

    expect(extractProduct(html, new URL('https://shop.test/'))).toEqual(
      NOTHING,
    );
  });

  it('guesses warmth from "heavyweight" when no weight is stated', () => {
    const html = `<script type="application/ld+json">
      {"@type": "Product", "name": "Heavyweight Hoodie"}</script>`;

    expect(extractProduct(html, new URL('https://shop.test/'))).toMatchObject({
      category: 'tops',
      type: 'hoodie',
      fabricWeight: null,
      warmth: 4,
    });
  });

  it.each([
    ['an image string', '"https://cdn.test/a.jpg"', ['https://cdn.test/a.jpg']],
    [
      'an ImageObject list',
      '[{"@type": "ImageObject", "contentUrl": "/a.jpg"}, {"url": ["/b.jpg"]}]',
      ['https://shop.test/a.jpg', 'https://shop.test/b.jpg'],
    ],
    ['a number', '42', []],
  ])('reads %s as image candidates', (_label, image, expected) => {
    const html = `<script type="application/ld+json">
      {"@type": "Product", "name": "Tee", "image": ${image}}</script>`;

    expect(extractProduct(html, new URL('https://shop.test/p')).images).toEqual(
      expected,
    );
  });

  it(`keeps at most ${MAX_IMAGE_CANDIDATES} image candidates`, () => {
    const images = Array.from({ length: 20 }, (_, i) => `"/img/${i}.jpg"`);
    const html = `<script type="application/ld+json">
      {"@type": "Product", "name": "Tee", "image": [${images.join(',')}]}</script>`;

    expect(
      extractProduct(html, new URL('https://shop.test/')).images,
    ).toHaveLength(MAX_IMAGE_CANDIDATES);
  });

  it('reads a brand given as a plain string, a Brand, or a list', () => {
    for (const brand of [
      '"Acme"',
      '{"@type": "Brand", "name": "Acme"}',
      '[{"name": "Acme"}]',
    ]) {
      const html = `<script type="application/ld+json">
        {"@type": "Product", "name": "Tee", "brand": ${brand}}</script>`;
      expect(extractProduct(html, new URL('https://shop.test/')).brand).toBe(
        'Acme',
      );
    }
  });

  it('passes over an empty Product node to the one that says something', () => {
    const html = `
      <script type="application/ld+json">{"@type": "Product", "@id": "#product"}</script>
      <script type="application/ld+json">{"@graph": [
        {"@type": "Product", "@id": "#product"},
        {"@type": "Product", "name": "Oxford Shirt", "brand": "Acme"}
      ]}</script>`;

    expect(extractProduct(html, new URL('https://shop.test/'))).toMatchObject({
      source: 'json-ld',
      name: 'Oxford Shirt',
      brand: 'Acme',
    });
  });

  it('does not credit JSON-LD when its only Product is empty', () => {
    const html = `
      <script type="application/ld+json">{"@type": "Product", "@id": "#product"}</script>
      <meta property="og:title" content="Oxford Shirt">`;

    expect(extractProduct(html, new URL('https://shop.test/'))).toMatchObject({
      source: 'open-graph',
      name: 'Oxford Shirt',
    });
  });

  it.each([
    'application/ld+json; charset=utf-8',
    'Application/LD+JSON ;charset="UTF-8"',
  ])('reads JSON-LD typed %s', (type) => {
    const html = `<script type='${type}'>{"@type": "Product", "name": "Tee"}</script>`;

    expect(extractProduct(html, new URL('https://shop.test/'))).toMatchObject({
      source: 'json-ld',
      name: 'Tee',
    });
  });

  it('bounds the name to the form field', () => {
    const html = `<script type="application/ld+json">
      {"@type": "Product", "name": "${'Tee '.repeat(200)}"}</script>`;

    expect(
      extractProduct(html, new URL('https://shop.test/')).name!.length,
    ).toBeLessThanOrEqual(200);
  });

  describe('hostile or broken pages', () => {
    const page = new URL('https://shop.test/');

    it.each([
      [
        'JSON-LD that is not JSON',
        '<script type="application/ld+json">{"@type": "Product", "name": </script>',
      ],
      [
        'JSON-LD that is a string',
        '<script type="application/ld+json">"Product"</script>',
      ],
      [
        'JSON-LD that is null',
        '<script type="application/ld+json">null</script>',
      ],
      [
        'a Product without fields',
        '<script type="application/ld+json">{"@type": "Product"}</script>',
      ],
      [
        'fields of the wrong types',
        '<script type="application/ld+json">{"@type": "Product", "name": {"a": 1}, "brand": 7, "offers": "free", "image": {"url": {"x": 1}}, "hasVariant": 3, "material": {}}</script>',
      ],
      [
        'an @type that is not a string',
        '<script type="application/ld+json">{"@type": {"x": 1}, "@graph": 5}</script>',
      ],
      [
        'deep nesting',
        `<script type="application/ld+json">${'['.repeat(5000)}${']'.repeat(5000)}</script>`,
      ],
      [
        'a nested Product past the depth bound',
        `<script type="application/ld+json">${'{"a":'.repeat(50)}{"@type":"Product","name":"Deep"}${'}'.repeat(50)}</script>`,
      ],
      [
        'an unclosed script',
        '<script type="application/ld+json">{"@type": "Product", "name": "Tee"}',
      ],
      ['an unclosed tag', '<meta property="og:title" content="Tee'],
      ['an unclosed comment', '<!-- <title>Hidden</title>'],
      [
        'a prototype key',
        '<script type="application/ld+json">{"__proto__": {"@type": "Product"}, "constructor": 1}</script>',
      ],
      [
        'bad character references',
        '<title>&#xD800; &#99999999; &bogus;</title>',
      ],
      [
        'a base that is not http',
        '<base href="javascript:alert(1)"><meta property="og:image" content="/a.jpg">',
      ],
    ])('survives %s', (_label, html) => {
      expect(() => extractProduct(html, page)).not.toThrow();
    });

    it('ignores a base href that is not http(s)', () => {
      const html =
        '<base href="javascript:alert(1)"><meta property="og:image" content="/a.jpg">';

      expect(extractProduct(html, page).images).toEqual([
        'https://shop.test/a.jpg',
      ]);
    });

    it('stops at the depth bound instead of walking forever', () => {
      const html = `<script type="application/ld+json">${'{"a":'.repeat(50)}{"@type":"Product","name":"Deep"}${'}'.repeat(50)}</script>`;

      expect(extractProduct(html, page).source).toBeNull();
    });

    it('skips a broken block and reads the next', () => {
      const html = `
        <script type="application/ld+json">{"@type": "Product", "name": </script>
        <script type="application/ld+json">{"@type": "Product", "name": "Second"}</script>`;

      expect(extractProduct(html, page).name).toBe('Second');
    });

    it('does not read a title or JSON-LD out of a script, a style or a comment', () => {
      const html = `
        <script>var s = '<title>From script</title>';</script>
        <style>/* <title>From style</title> */</style>
        <!-- <script type="application/ld+json">{"@type":"Product","name":"From comment"}</script> -->
        <title>Real &amp; Proper</title>`;

      expect(extractProduct(html, page)).toMatchObject({
        source: 'title',
        name: 'Real & Proper',
      });
    });

    it('reads attributes in any quoting and order, with ">" inside a value', () => {
      const html = `<meta content='A > B Tee' property=og:title>`;

      expect(extractProduct(html, page).name).toBe('A > B Tee');
    });

    it('scans a large page in linear time', () => {
      // Many unterminated scripts and quotes: a backtracking scanner would
      // take minutes here.
      const html =
        '<script type="application/ld+json">'.repeat(20000) +
        '<a href="'.repeat(20000) +
        'x'.repeat(1024 * 1024);
      const started = performance.now();

      extractProduct(html, page);

      expect(performance.now() - started).toBeLessThan(1000);
    });
  });
});

describe('parsePrice', () => {
  it.each([
    [48, '48'],
    [48.5, '48.5'],
    ['48.00', '48.00'],
    ['$1,299.00', '1299.00'],
    ['29,99', '29.99'],
    ['USD 120', '120'],
  ])('reads %j as %s', (value, expected) => {
    expect(parsePrice(value)).toBe(expected);
  });

  it.each([0, '0.00', '', 'free', '1.299,00', -5, '1e9', null, undefined])(
    'refuses %j',
    (value) => {
      expect(parsePrice(value)).toBeNull();
    },
  );

  // #693: what numeric(10, 2) holds once Postgres rounds it to cents (half
  // away from zero), judged on the digits, never a float.
  it.each([
    ['99999999.99', '99999999.99'],
    ['99999999.994', '99999999.994'],
    ['0.005', '0.005'],
    ['0.01', '0.01'],
  ])('keeps %j, which the column holds', (value, expected) => {
    expect(parsePrice(value)).toBe(expected);
  });

  it.each([
    '123456789',
    123456789,
    '100000000',
    '99999999.995',
    '99999999.9999',
    '0.004',
    '0.0001',
  ])('refuses %j, which the column would refuse or store as 0.00', (value) => {
    expect(parsePrice(value)).toBeNull();
  });
});

// #693: what the extractor hands on is what order_item and the garment form
// store (the order mail's poll reads every product page through
// readProductPage, which is extractProduct), so no page text can carry a
// control character Postgres refuses, nor a price overflow its column.
describe('the stored-value boundary', () => {
  const url = new URL('https://acme-supply.test/products/tee');
  const jsonLd = (product: object) =>
    page(
      `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', ...product })}</script>`,
    );
  // eslint-disable-next-line no-control-regex -- the characters that must be gone
  const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

  it('strips control characters, NUL included, from every JSON-LD text field', () => {
    const product = extractProduct(
      jsonLd({
        name: 'Pocket\u0000 Tee\u0007',
        brand: { '@type': 'Brand', name: '\u0000Acme\u001f Supply\u007f' },
        offers: { price: '28.00', priceCurrency: 'USD' },
      }),
      url,
    );
    expect(product.name).toBe('Pocket Tee');
    expect(product.brand).toBe('Acme Supply');
  });

  it('strips them after decoding entities, in the meta tags and the title', () => {
    const product = extractProduct(
      page(
        '<meta property="og:title" content="Linen&#x7f; Shirt&#1;"><meta property="product:brand" content="&#2;Acme"><meta property="product:price:amount" content="40">',
      ),
      url,
    );
    expect(product.name).toBe('Linen Shirt');
    expect(product.brand).toBe('Acme');
    const titled = extractProduct(
      page('<title>Tee&#1; &#x1F;Navy&#0;&#x0;</title>'),
      url,
    );
    expect(titled.name).not.toMatch(CONTROL);
    expect(titled.name).toMatch(/^Tee Navy/);
  });

  it('drops a price the column cannot hold, keeping the rest', () => {
    const product = extractProduct(
      jsonLd({
        name: 'Tee',
        offers: { price: 123456789, priceCurrency: 'USD' },
      }),
      url,
    );
    expect(product.name).toBe('Tee');
    expect(product.price).toBeNull();
  });
});
