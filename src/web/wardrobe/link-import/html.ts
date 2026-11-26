/**
 * The parts of an HTML document the link import reads: `<title>`, `<meta>`
 * tags, `<base href>` and JSON-LD scripts; and the links (`<a href>`) the
 * order mail reads in an email's body (#25, ../order-mail/links.ts). Not an HTML parser: one linear pass over the tags that skips comments and the bodies of script, style
 * and textarea, which is all metadata extraction needs. The input is a
 * stranger's page (at most 2 MB, outbound-fetch.ts), so nothing here may
 * backtrack or recurse on it: every search moves forward from where the
 * last one stopped.
 */

export interface DocumentMetadata {
  /** The first `<title>`'s text, entities decoded. */
  title: string | null;
  /** The first `<base href>`, raw (resolve it against the page's URL). */
  baseHref: string | null;
  /**
   * Every `<meta>` with content, keyed by its `property`, `name` or
   * `itemprop` in lower case, values decoded, in document order.
   */
  metas: ReadonlyMap<string, readonly string[]>;
  /** The text of each `<script type="application/ld+json">`, unparsed. */
  jsonLd: readonly string[];
  /** Each `<a href>`, decoded and trimmed, in document order, at most MAX_LINKS. */
  links: readonly string[];
}

const MAX_JSON_LD_BLOCKS = 20;
const MAX_LINKS = 200;
const TAG_NAME = /[a-zA-Z][a-zA-Z0-9-]*/y;
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea']);

interface Scan {
  title: string | null;
  baseHref: string | null;
  metas: Map<string, string[]>;
  jsonLd: string[];
  links: string[];
}

export function scanDocument(html: string): DocumentMetadata {
  const scan: Scan = {
    title: null,
    baseHref: null,
    metas: new Map(),
    jsonLd: [],
    links: [],
  };
  // Each step returns where the next starts, strictly further on, or -1.
  for (let pos = 0; pos >= 0 && pos < html.length; ) {
    pos = readNextTag(html, pos, scan);
  }
  return scan;
}

/** Reads the comment or tag at the next "<" from `pos`. */
function readNextTag(html: string, pos: number, scan: Scan): number {
  const lt = html.indexOf('<', pos);
  if (lt < 0) return -1;
  if (html.startsWith('<!--', lt)) {
    const end = html.indexOf('-->', lt + 4);
    return end < 0 ? -1 : end + 3;
  }
  TAG_NAME.lastIndex = lt + 1;
  const name = TAG_NAME.exec(html)?.[0].toLowerCase();
  if (!name) return lt + 1;
  const tagEnd = findTagEnd(html, TAG_NAME.lastIndex);
  if (tagEnd < 0) return -1;
  const attributes = parseAttributes(html.slice(TAG_NAME.lastIndex, tagEnd));
  if (name === 'title' || RAW_TEXT_ELEMENTS.has(name)) {
    return readText(html, name, attributes, tagEnd + 1, scan);
  }
  if (name === 'a') {
    readLink(attributes, scan);
  } else {
    readEmptyElement(name, attributes, scan);
  }
  return tagEnd + 1;
}

function readEmptyElement(
  name: string,
  attributes: Map<string, string>,
  scan: Scan,
): void {
  if (name === 'meta') {
    addMeta(scan.metas, attributes);
  } else if (name === 'base') {
    scan.baseHref ??= attributes.get('href')?.trim() ?? null;
  }
}

function readLink(attributes: Map<string, string>, scan: Scan): void {
  const href = attributes.get('href');
  if (!href || scan.links.length === MAX_LINKS) return;
  scan.links.push(decodeEntities(href).trim());
}

/**
 * A title's or raw-text element's content, up to its closing tag (the
 * rest of the document when it has none, which ends the scan).
 */
function readText(
  html: string,
  name: string,
  attributes: Map<string, string>,
  pos: number,
  scan: Scan,
): number {
  const close = findClosingTag(html, name, pos);
  const text = html.slice(pos, close < 0 ? html.length : close);
  if (name === 'title') {
    scan.title ??= plainText(text);
  } else if (
    name === 'script' &&
    isJsonLd(attributes) &&
    scan.jsonLd.length < MAX_JSON_LD_BLOCKS
  ) {
    scan.jsonLd.push(text);
  }
  return close;
}

/**
 * The `>` that ends a tag whose attributes start at `from`, skipping `>`
 * inside quoted attribute values; -1 when the document ends first.
 */
function findTagEnd(html: string, from: number): number {
  let afterEquals = false;
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (ch === '>') return i;
    if ((ch === '"' || ch === "'") && afterEquals) {
      const close = html.indexOf(ch, i + 1);
      if (close < 0) return -1;
      i = close;
      afterEquals = false;
    } else if (ch === '=') {
      afterEquals = true;
    } else if (!/\s/.test(ch)) {
      afterEquals = false;
    }
  }
  return -1;
}

function findClosingTag(html: string, name: string, from: number): number {
  const closing = new RegExp(`</${name}[\\s>/]`, 'gi');
  closing.lastIndex = from;
  return closing.exec(html)?.index ?? -1;
}

const ATTRIBUTE =
  /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Attribute names in lower case to their raw values (first one wins). */
function parseAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of text.matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase();
    if (!attributes.has(name)) {
      attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
    }
  }
  return attributes;
}

function addMeta(
  metas: Map<string, string[]>,
  attributes: Map<string, string>,
): void {
  const key =
    attributes.get('property') ??
    attributes.get('name') ??
    attributes.get('itemprop');
  const content = attributes.get('content');
  if (!key || content === undefined) return;
  const value = decodeEntities(content).trim();
  if (!value) return;
  const normalized = key.trim().toLowerCase();
  const values = metas.get(normalized);
  if (values) values.push(value);
  else metas.set(normalized, [value]);
}

// The media type's essence: parameters (`; charset=utf-8`) do not change it.
function isJsonLd(attributes: Map<string, string>): boolean {
  const essence = attributes.get('type')?.split(';', 1)[0];
  return essence?.trim().toLowerCase() === 'application/ld+json';
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  trade: '™',
  reg: '®',
  copy: '©',
  eacute: 'é',
  egrave: 'è',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
};

// C0, DEL and C1. NUL among them is what Postgres' text refuses (#693).
// eslint-disable-next-line no-control-regex -- the control characters are what is removed
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * A page's text as display text: entities decoded, then every control
 * character a space, whitespace collapsed, trimmed; null when nothing is
 * left. Controls go after decoding (`&#1;` decodes to one), so no stored
 * value can hold one: the title here, and every text field extract.ts reads
 * (its cleanText), which the poll stores and link import prefills.
 */
export function plainText(text: string): string | null {
  return (
    decodeEntities(text)
      .replace(CONTROL_CHARACTERS, ' ')
      .replace(/\s+/g, ' ')
      .trim() || null
  );
}

/**
 * Character references: numeric ones and the named ones product pages use.
 * An unknown name or an invalid code point is left as written.
 */
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/gi,
    (entity, decimal?: string, hex?: string, named?: string) => {
      if (named) return NAMED_ENTITIES[named.toLowerCase()] ?? entity;
      const code = decimal ? Number(decimal) : parseInt(hex!, 16);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : entity;
    },
  );
}
