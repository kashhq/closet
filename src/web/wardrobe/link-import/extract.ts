import type {
  GarmentCategory,
  Material,
  Warmth,
} from '../../../wardrobe/properties';
import type { GarmentColor } from '../../../wardrobe/properties';
import { BRAND_MAX, NAME_MAX } from '../garment-input';
import {
  guessColors,
  guessFabricWeight,
  guessKind,
  guessMaterials,
  guessWeightWarmth,
} from './guess';
import { type DocumentMetadata, plainText, scanDocument } from './html';

/**
 * What a product page says about the garment on it, as garment form
 * prefills (issue #6; docs/plans/2026-09-26-wardrobe-features.md, section
 * 0). Sources in order of reliability: schema.org Product JSON-LD, then
 * Open Graph and product meta tags, then `<title>`; each field comes from
 * the first source that has it. Colour, category, type, materials and
 * weight are guessed from the words (guess.ts). Pure: HTML in, prefills out.
 *
 * The page is a stranger's and may be hostile or broken: nothing here
 * throws on any input, JSON-LD that does not parse is skipped, and every
 * value is bounded before it leaves.
 */

interface ExtractedPrice {
  /** A plain decimal ("1299.00"), never a float, for a numeric column. */
  amount: string;
  /** ISO 4217, upper case, when the page says. */
  currency: string | null;
}

type ExtractionSource = 'json-ld' | 'open-graph' | 'title';

/**
 * How much of a product the page gave: `product` (schema.org Product, or
 * Open Graph with product tags), `page` (Open Graph alone: a title and a
 * picture, which a landing page has too) or `title-only` (nothing but a
 * `<title>`, or a link that ended away from the product's page). Only the
 * first two are worth prefilling a garment from.
 */
export type ExtractionConfidence = 'product' | 'page' | 'title-only';

export interface ExtractedProduct {
  /** The most reliable source that yielded anything; null for none. */
  source: ExtractionSource | null;
  confidence: ExtractionConfidence;
  name: string | null;
  brand: string | null;
  price: ExtractedPrice | null;
  colors: GarmentColor[];
  category: GarmentCategory | null;
  type: string | null;
  materials: Material[];
  /** Grams per square metre, only when the page states a weight. */
  fabricWeight: number | null;
  /** Only from "heavyweight"/"lightweight" words without a stated weight. */
  warmth: Warmth | null;
  /** Absolute http(s) image URLs, best first, without duplicates. */
  images: string[];
}

export const MAX_IMAGE_CANDIDATES = 8;
const MAX_URL_LENGTH = 2048;
const MAX_HINT_TEXT = 5000;

/**
 * `pageUrl` is where the page was read (after redirects); `requestedUrl`
 * is the link that was asked for, when it differs: a link that ended on a
 * shallower address (see leftProductPath) is `title-only` whatever the page
 * says, because it is the shop's landing page, not the product.
 */
export function extractProduct(
  html: string,
  pageUrl: URL,
  requestedUrl: URL = pageUrl,
): ExtractedProduct {
  const document = scanDocument(html);
  // Most reliable first; a source that found nothing is null.
  const ogSiteName = metaText(document.metas, 'og:site_name');
  const domainName = registrableName(pageUrl);
  const siteNames = [ogSiteName, domainName].filter((name) => name !== null);
  const sources = [
    findProduct(document.jsonLd),
    openGraph(document, siteNames),
    titleFields(document.title, siteNames),
  ].filter((source) => source !== null);
  const fields = mergeFields(sources);
  const guessed = guessProperties(fields);
  const source = sources[0]?.source ?? null;
  const confidence = confidenceOf(source, document, requestedUrl, pageUrl);
  return {
    source,
    confidence,
    name: clip(fields.name, NAME_MAX),
    // The shop stands in for a brand only where the page gave less than a
    // product: a retailer of many brands (Nordstrom) is never the
    // garment's brand, and a product read that names none keeps null.
    brand: clip(
      fields.brand ??
        (source !== null && confidence !== 'product'
          ? (ogSiteName ?? domainName)
          : null),
      BRAND_MAX,
    ),
    price: fields.price,
    ...guessed,
    colors:
      guessed.colors.length > 0
        ? guessed.colors
        : guessColors(urlColorWords(pageUrl, confidence)),
    images: absoluteImages(
      sources.flatMap((source) => source.images),
      baseUrl(document.baseHref, pageUrl),
    ),
  };
}

function confidenceOf(
  source: ExtractionSource | null,
  document: DocumentMetadata,
  requestedUrl: URL,
  pageUrl: URL,
): ExtractionConfidence {
  if (leftProductPath(requestedUrl, pageUrl)) return 'title-only';
  if (source === 'json-ld') return 'product';
  if (source === 'open-graph') {
    return hasProductTags(document) ? 'product' : 'page';
  }
  return 'title-only';
}

/** Open Graph that says it is a product: og:type, a `product:` or price tag. */
function hasProductTags({ metas }: DocumentMetadata): boolean {
  return (
    metas.get('og:type')?.some((type) => /^(?:og:)?product/i.test(type)) ===
      true ||
    [...metas.keys()].some(
      (key) => key.startsWith('product:') || key.startsWith('og:price:'),
    )
  );
}

/** A locale landing root's segment: `us`, `en`, `en-us`, `fr_CA`. */
const LOCALE_SEGMENT = /^[a-z]{2}(?:[-_][a-z]{2,4})?$/i;

/**
 * A redirect that left the product path: the link named a page below the
 * site's root and the final address is a home page: the site's root, a
 * single-segment locale root (`/en-us/`, `/us`), or another host's root.
 * Shops send unknown, expired and bot-blocked products there, and its
 * title and logo are not the garment. Any other change is a shop tidying
 * its address, not losing the product: a canonical redirect to an ancestor
 * (`/product/123/slug` to `/product/123`), a locale prefix, a same-depth
 * address.
 */
function leftProductPath(requested: URL, final: URL): boolean {
  const asked = pathSegments(requested);
  const ended = pathSegments(final);
  if (asked.length <= ended.length) return false;
  if (requested.hostname !== final.hostname) return ended.length === 0;
  return (
    ended.length === 0 || (ended.length === 1 && LOCALE_SEGMENT.test(ended[0]))
  );
}

function pathSegments(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean);
}

function metaText(
  metas: ReadonlyMap<string, readonly string[]>,
  key: string,
): string | null {
  const value = metas.get(key)?.[0];
  return value === undefined ? null : cleanText(value);
}

// Second-level registries, so "shop.example.co.uk" is "example", not "co".
// Deliberately tiny: a miss gives a worse brand guess, never a wrong
// security decision, and the person reviews the form.
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov']);

// Platforms that host many shops under one domain: the shop is the label
// left of the platform ("acme.myshopify.com" is "Acme"), never the platform
// itself. A shop on its own domain is not listed and reads as before. Small
// on purpose, like SECOND_LEVEL: a miss gives the platform's name, which the
// person corrects on the form (the page's og:site_name wins before either).
const HOSTING_DOMAINS = new Set([
  'myshopify.com',
  'squarespace.com',
  'wixsite.com',
  'bigcartel.com',
  'weebly.com',
  'webflow.io',
  'mybigcommerce.com',
]);

/**
 * "Uniqlo" from `www.uniqlo.com` or `shop.uniqlo.co.uk`, "Acme" from
 * `acme.myshopify.com`; null for an IP or a bare platform host.
 */
function registrableName(url: URL): string | null {
  const labels = url.hostname.split('.');
  if (labels.length < 2 || /^[\d.]+$|:/.test(url.hostname)) return null;
  const tld = labels.length - 1;
  const hosted = HOSTING_DOMAINS.has(labels.slice(-2).join('.'));
  const registry = hosted || SECOND_LEVEL.has(labels[tld - 1]);
  const name =
    registry && labels.length > 2 ? labels[tld - 2] : labels[tld - 1];
  if (hosted && (labels.length === 2 || name === 'www')) return null;
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : null;
}

/**
 * The words of a product's address that a colour can hide in. The explicit
 * `color`/`colour` variant parameter (any key case: `?Color=Olive`) is
 * unambiguous and read at every confidence. The last path segment
 * (`mens-merino-sweater-navy`) is read only where the page gave less than a
 * product, like the brand fallback: a slug names brands and styles too
 * ('red-wing-boots', 'blackwatch-plaid').
 */
function urlColorWords(url: URL, confidence: ExtractionConfidence): string {
  const slug =
    confidence === 'product'
      ? ''
      : (pathSegments(url).pop() ?? '').replace(/\.[a-z0-9]{2,5}$/i, '');
  const variants = [...url.searchParams]
    .filter(([key]) => /^colou?r$/i.test(key))
    .map(([, value]) => value);
  return [slug, ...variants].join(' ').replace(/[-_+]+/g, ' ');
}

/** What one source says, as text; null where it says nothing. */
interface SourceFields {
  source: ExtractionSource;
  name: string | null;
  brand: string | null;
  color: string | null;
  material: string | null;
  description: string | null;
  category: string | null;
  price: ExtractedPrice | null;
  images: string[];
}

type MergedFields = Omit<SourceFields, 'source' | 'images'>;

const EMPTY_FIELDS: MergedFields = {
  name: null,
  brand: null,
  color: null,
  material: null,
  description: null,
  category: null,
  price: null,
};

/** Each field from the first source that has it. */
function mergeFields(sources: readonly SourceFields[]): MergedFields {
  const merged = { ...EMPTY_FIELDS };
  for (const key of Object.keys(EMPTY_FIELDS) as (keyof MergedFields)[]) {
    const from = sources.find((source) => source[key] !== null);
    if (from) Object.assign(merged, { [key]: from[key] });
  }
  return merged;
}

/**
 * The guesses from the words: the category from the name (else the page's
 * own category), the colour from the colour field (else the name), the
 * materials from the material field (else the name and description).
 */
function guessProperties(
  fields: MergedFields,
): Pick<
  ExtractedProduct,
  'colors' | 'category' | 'type' | 'materials' | 'fabricWeight' | 'warmth'
> {
  const hints = hintText(fields);
  const kind = kindOf(fields);
  const fabricWeight = guessFabricWeight(hints);
  return {
    colors: guessColors(fields.color ?? fields.name ?? ''),
    ...kind,
    materials: guessMaterials(fields.material ?? hints),
    fabricWeight,
    warmth:
      kind.category && fabricWeight === null
        ? guessWeightWarmth(hints, kind.category, kind.type)
        : null,
  };
}

/** Where material and weight are stated: the name, material and description. */
function hintText({ name, material, description }: MergedFields): string {
  return [name, material, description?.slice(0, MAX_HINT_TEXT)]
    .filter(Boolean)
    .join(' \n ');
}

function kindOf(
  fields: MergedFields,
): Pick<ExtractedProduct, 'category' | 'type'> {
  const kind = guessKind(fields.name ?? '') ?? guessKind(fields.category ?? '');
  return kind ?? { category: null, type: null };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const PRODUCT_TYPES = new Set([
  'product',
  'productgroup',
  'individualproduct',
  'productmodel',
]);
const MAX_DEPTH = 8;
const MAX_NODES = 5000;

/**
 * The first Product node in the page's JSON-LD blocks that says anything.
 * Pages often reference the product before describing it (`{"@type":
 * "Product", "@id": "#product"}` in a breadcrumb or an early block), so an
 * empty node is passed over, not taken.
 */
function findProduct(blocks: readonly string[]): SourceFields | null {
  for (const block of blocks) {
    const parsed = parseJsonLd(block);
    if (parsed === undefined) continue;
    for (const node of productNodes(parsed, { nodes: 0 }, 0)) {
      const fields = productFields(node);
      if (saysAnything(fields)) return fields;
    }
  }
  return null;
}

function saysAnything(fields: SourceFields): boolean {
  return (
    fields.images.length > 0 ||
    (Object.keys(EMPTY_FIELDS) as (keyof MergedFields)[]).some(
      (key) => fields[key] !== null,
    )
  );
}

/**
 * JSON-LD as pages really write it: sometimes wrapped in a comment or
 * CDATA, sometimes with raw newlines inside strings (which JSON forbids).
 * Undefined when it still does not parse.
 */
function parseJsonLd(raw: string): Json | undefined {
  const text = raw
    .trim()
    .replace(/^(?:<!--|<!\[CDATA\[)/, '')
    .replace(/(?:-->|\]\]>)$/, '')
    .trim();
  // eslint-disable-next-line no-control-regex -- raw control characters are the breakage being repaired
  for (const candidate of [text, text.replace(/[\u0000-\u001f]+/g, ' ')]) {
    try {
      return JSON.parse(candidate) as Json;
    } catch {
      // Try the next repair, then give up on this block.
    }
  }
  return undefined;
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A node's @type names, without a vocabulary prefix, lower case. */
function typeNames(node: JsonObject): string[] {
  const type = node['@type'];
  const names = Array.isArray(type) ? type : [type];
  return names
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.replace(/^.*[/:#]/, '').toLowerCase());
}

/**
 * The Product nodes, depth-first through arrays, `@graph` and nested
 * objects (a WebPage's `mainEntity`), bounded in depth and node count so a
 * hostile document cannot make the walk expensive. A Product's own
 * children are not searched (its variants are its own fields).
 */
function* productNodes(
  value: Json,
  budget: { nodes: number },
  depth: number,
): Generator<JsonObject> {
  if (depth > MAX_DEPTH || ++budget.nodes > MAX_NODES) return;
  if (isObject(value) && typeNames(value).some((t) => PRODUCT_TYPES.has(t))) {
    yield value;
    return;
  }
  for (const child of childNodes(value)) {
    yield* productNodes(child, budget, depth + 1);
  }
}

/** The arrays and objects inside an array or object. */
function childNodes(value: Json): Json[] {
  return members(value).filter((child) => typeof child === 'object' && child);
}

function members(value: Json): Json[] {
  if (Array.isArray(value)) return value;
  if (isObject(value)) return Object.values(value);
  return [];
}

function productFields(node: JsonObject): SourceFields {
  // A ProductGroup (Shopify's variants) may keep offers and images on its
  // variants only.
  const variants = asArray(node.hasVariant).filter(isObject);
  return {
    source: 'json-ld',
    name: text(node.name),
    brand: text(node.brand) ?? text(node.manufacturer),
    color: text(node.color),
    material:
      asArray(node.material)
        .map((item) => text(item))
        .filter(Boolean)
        .join(', ') || null,
    description: text(node.description),
    category: text(node.category),
    price:
      offerPrice(node.offers) ??
      variants.map((v) => offerPrice(v.offers)).find(Boolean) ??
      null,
    images: [
      ...imageUrls(node.image),
      ...variants.flatMap((variant) => imageUrls(variant.image)),
    ],
  };
}

function asArray(value: Json | undefined): Json[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * A value as display text: a string or number as it is, a Thing by its
 * name (`{"@type": "Brand", "name": "Acme"}`), a list by its first item.
 * Entities decoded (pages double-encode "Men&#39;s"), tags stripped,
 * whitespace collapsed.
 */
function text(value: Json | undefined, depth = 0): string | null {
  if (typeof value !== 'object' || value === null) return scalarText(value);
  if (depth > 2) return null;
  const candidates = Array.isArray(value)
    ? value
    : [value.name, value['@value']];
  for (const candidate of candidates) {
    const found = text(candidate, depth + 1);
    if (found) return found;
  }
  return null;
}

function scalarText(value: Json | undefined): string | null {
  if (typeof value === 'string') return cleanText(value);
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : null;
}

function cleanText(value: string): string | null {
  return plainText(value.replace(/<[^>]*>/g, ' '));
}

/** A string (or a list, or an ImageObject's url/contentUrl) as URLs. */
function imageUrls(value: Json | undefined, depth = 0): string[] {
  if (typeof value === 'string') return [value];
  if (depth > 2) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => imageUrls(item, depth + 1));
  }
  if (isObject(value)) {
    return imageUrls(value.contentUrl ?? value.url, depth + 1);
  }
  return [];
}

/** The first priced Offer (or AggregateOffer's lowPrice) with its currency. */
function offerPrice(offers: Json | undefined): ExtractedPrice | null {
  for (const offer of asArray(offers)) {
    if (!isObject(offer)) continue;
    const specification = asArray(offer.priceSpecification).find(isObject);
    const amount = parsePrice(
      offer.price ?? offer.lowPrice ?? specification?.price,
    );
    if (amount) {
      return {
        amount,
        currency: parseCurrency(
          offer.priceCurrency ?? specification?.priceCurrency,
        ),
      };
    }
  }
  return null;
}

function priceText(value: Json | undefined): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return '';
}

/** The largest price in cents a `numeric(10, 2)` column holds. */
const MAX_PRICE_CENTS = 10n ** 10n - 1n;

/**
 * A positive amount as a plain decimal string: 29, "29.00", "$1,299.00",
 * "USD 120", "29,99" (a decimal comma). Null for anything else: 0 (a page's
 * "no price"), negatives, ranges ("10 - 20"), exponents, two numbers, and
 * what `numeric(10, 2)` (order_item.price, garment.price) would refuse or
 * store as 0.00 once Postgres rounds it to cents (#693).
 */
export function parsePrice(value: Json | undefined): string | null {
  const raw = priceText(value);
  const numbers = raw.match(/[\d.,]+/g);
  if (numbers?.length !== 1 || raw.includes('-')) return null;
  let digits = numbers[0];
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(digits)) {
    digits = digits.replace(/,/g, '');
  } else if (/^\d+,\d{1,2}$/.test(digits)) {
    digits = digits.replace(',', '.');
  }
  const decimal = /^(\d{1,9})(?:\.(\d{1,4}))?$/.exec(digits);
  if (!decimal) return null;
  const cents = roundedCents(decimal[1], decimal[2] ?? '');
  return cents > 0n && cents <= MAX_PRICE_CENTS ? digits : null;
}

/**
 * A decimal's value in cents as Postgres rounds it into a scale of 2: half
 * away from zero (99999999.995 is 10000000000 cents, past the column), on
 * the digits themselves, never a float.
 */
function roundedCents(whole: string, fraction: string): bigint {
  const cents =
    BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return fraction.length > 2 && fraction[2] >= '5' ? cents + 1n : cents;
}

function parseCurrency(value: Json | undefined): string | null {
  return typeof value === 'string' && /^[a-z]{3}$/i.test(value.trim())
    ? value.trim().toUpperCase()
    : null;
}

/**
 * Open Graph, its product: extension, and the Twitter card's image; null
 * when the page has none of the product ones (a plain description meta tag
 * alone is not a product).
 */
function openGraph(
  document: DocumentMetadata,
  siteNames: readonly string[],
): SourceFields | null {
  const all = (...keys: string[]) =>
    keys.flatMap((key) => document.metas.get(key) ?? []);
  const first = (...keys: string[]) => {
    const value = all(...keys)[0];
    return value === undefined ? null : cleanText(value);
  };
  const amount = parsePrice(all('product:price:amount', 'og:price:amount')[0]);
  const fields: SourceFields = {
    source: 'open-graph',
    name:
      withoutSiteName(first('og:title', 'twitter:title') ?? '', siteNames) ||
      null,
    brand: first('product:brand', 'og:brand'),
    color: first('product:color'),
    material: null,
    description: first('og:description', 'description'),
    category: null,
    price: amount
      ? {
          amount,
          currency: parseCurrency(
            all('product:price:currency', 'og:price:currency')[0],
          ),
        }
      : null,
    images: all(
      'og:image:secure_url',
      'og:image',
      'og:image:url',
      'twitter:image',
      'twitter:image:src',
    ),
  };
  const found =
    fields.name ??
    fields.brand ??
    fields.color ??
    fields.price ??
    fields.images[0];
  return found ? fields : null;
}

/** The last resort: `<title>` without the site's name after its separator. */
function titleFields(
  title: string | null,
  siteNames: readonly string[],
): SourceFields | null {
  if (!title) return null;
  return {
    ...EMPTY_FIELDS,
    source: 'title',
    name: withoutSiteName(title, siteNames),
    images: [],
  };
}

/**
 * "Mens Merino Sweater | UNIQLO US" is "Mens Merino Sweater": the text after
 * the last " | ", " – " or " — " goes only when it is the site's name (the
 * page's og:site_name or its domain's name, folded), alone or followed by
 * words ("UNIQLO US"). Never by position: "Pocket Tee – Navy" keeps its
 * variant, and a hyphen is as often part of a name as a separator.
 */
function withoutSiteName(title: string, siteNames: readonly string[]): string {
  const cut = Math.max(
    ...[' | ', ' – ', ' — '].map((separator) => title.lastIndexOf(separator)),
  );
  if (cut <= 0) return title;
  const suffix = folded(title.slice(cut + 3));
  const isSite = siteNames.some((name) => {
    const site = folded(name);
    return site !== '' && (suffix === site || suffix.startsWith(`${site} `));
  });
  return isSite ? title.slice(0, cut).trim() : title;
}

/** Lower case, anything but letters and digits a single space. */
function folded(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function clip(value: string | null | undefined, max: number): string | null {
  return value ? value.slice(0, max).trim() : null;
}

/** `<base href>` when it is an http(s) URL, else the page's own URL. */
function baseUrl(baseHref: string | null, pageUrl: URL): URL {
  if (!baseHref) return pageUrl;
  try {
    const base = new URL(baseHref, pageUrl);
    return base.protocol === 'http:' || base.protocol === 'https:'
      ? base
      : pageUrl;
  } catch {
    return pageUrl;
  }
}

/**
 * Candidates resolved against the page (protocol-relative CDN URLs
 * included), http(s) only, fragments dropped, each once, at most
 * MAX_IMAGE_CANDIDATES. Fetching them is outbound-fetch's job, which
 * checks each again: a URL here is only a string.
 */
function absoluteImages(candidates: readonly string[], base: URL): string[] {
  const images: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.length > MAX_URL_LENGTH) continue;
    let url: URL;
    try {
      url = new URL(trimmed, base);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    url.hash = '';
    if (url.href.length > MAX_URL_LENGTH || images.includes(url.href)) {
      continue;
    }
    images.push(url.href);
    if (images.length === MAX_IMAGE_CANDIDATES) break;
  }
  return images;
}
