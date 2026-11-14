/**
 * Whether a forwarded email is the owner's (#25; plan
 * docs/plans/2026-09-28-order-email-import.md, Trust check). Pure. Anyone
 * can send mail to the order account, and a From header is only a claim,
 * so an email is read only when:
 *
 * - its From is exactly one address, one of ORDER_MAIL_SENDERS; and
 * - the topmost Authentication-Results, the one Fastmail's own MX added
 *   (its authserv-id ends in FASTMAIL_AUTHSERV), reads whole (RFC 8601,
 *   quoted strings and comments included), names no vouching method twice
 *   with two results, and says `dkim=pass` for a `header.d` aligned with
 *   the From address's domain (equal, or one a subdomain of the other) or
 *   `dmarc=pass` for exactly that domain as `header.from`. SPF alone never
 *   counts (#706): it vouches for the envelope sender, not the From.
 *
 * Only the topmost header counts: a receiving server adds its own above
 * whatever the message arrived with, so any lower one may be the sender's
 * forgery. A mailbox's auto-forward rule keeps the retailer as From, so
 * only mail the owner forwarded by hand passes; that is by design.
 */

/** Fastmail's MX hosts (mx1.messagingengine.com ...) name themselves so. */
const FASTMAIL_AUTHSERV = 'messagingengine.com';

export interface SenderEvidence {
  /** JMAP's parsed From: its addresses (null for a group or none). */
  from: readonly { email: string | null }[] | null;
  /** Every Authentication-Results header as text, topmost first. */
  authenticationResults: readonly string[];
}

type UntrustedReason =
  | 'no-single-sender'
  | 'sender-not-allowed'
  | 'no-authentication-results'
  | 'unreadable-authentication-results'
  | 'foreign-authserv'
  | 'conflicting-results'
  | 'authentication-failed';

export type TrustVerdict =
  | { trusted: true; sender: string }
  | {
      trusted: false;
      reason: UntrustedReason;
      /** The From domain, for the log line; never the address. */
      domain: string | null;
    };

export function judgeSender(
  { from, authenticationResults }: SenderEvidence,
  allowedSenders: readonly string[],
): TrustVerdict {
  const addresses = (from ?? [])
    .map((address) => address.email?.trim().toLowerCase())
    .filter((email): email is string => Boolean(email));
  if (addresses.length !== 1) {
    return {
      trusted: false,
      reason: 'no-single-sender',
      domain: addresses[0] ? domainOf(addresses[0]) : null,
    };
  }
  const sender = addresses[0];
  const domain = domainOf(sender);
  const refuse = (reason: UntrustedReason): TrustVerdict => ({
    trusted: false,
    reason,
    domain,
  });
  if (!allowedSenders.includes(sender)) return refuse('sender-not-allowed');
  const failure = authenticationFailure(authenticationResults[0], domain);
  return failure ? refuse(failure) : { trusted: true, sender };
}

/** Why the topmost header does not vouch for `domain`, or undefined. */
function authenticationFailure(
  topmost: string | undefined,
  domain: string | null,
): UntrustedReason | undefined {
  if (topmost === undefined) return 'no-authentication-results';
  const results = parseAuthenticationResults(topmost);
  if (results === null) return 'unreadable-authentication-results';
  if (!isFastmail(results.authservId)) return 'foreign-authserv';
  if (hasConflict(results.methods)) return 'conflicting-results';
  return domain !== null && vouchesFor(results.methods, domain)
    ? undefined
    : 'authentication-failed';
}

interface MethodResult {
  /** `dkim`, `spf`, `dmarc` ... lower case. */
  method: string;
  /** `pass`, `fail`, `none` ... lower case. */
  result: string;
  /**
   * `header.d`, `smtp.mailfrom`, `reason` ... keys and values lower case,
   * a quoted string's content unquoted.
   */
  properties: ReadonlyMap<string, string>;
}

export interface AuthenticationResults {
  authservId: string;
  methods: MethodResult[];
}

/** Past this the header is refused, never cut: a cut could drop a failure. */
const MAX_HEADER_LENGTH = 16_384;

/**
 * RFC 8601's `authserv-id [version]; method=result [ptype.property=value
 * ...]; ...` (or `; none`), read by one scanner that knows quoted strings
 * (backslash escapes included) and nested comments, so a `;` or `=` inside
 * either never ends a piece (#706: a sender-chosen `smtp.mailfrom` or
 * `header.i` can be a quoted local-part). Fails closed: a header it cannot
 * read whole (an unterminated quote or comment, a stray `)`, a property
 * named twice with two values, a piece that is not `name=value`) is null,
 * never a partial answer.
 */
export function parseAuthenticationResults(
  header: string,
): AuthenticationResults | null {
  if (header.length > MAX_HEADER_LENGTH) return null;
  try {
    return new Scanner(header).authenticationResults();
  } catch (error) {
    if (error instanceof Unreadable) return null;
    throw error;
  }
}

class Unreadable extends Error {}

const WHITESPACE = new Set([' ', '\t', '\r', '\n']);
// RFC 8601's Keyword (a method or a result), and a property's name, which
// adds the dot of `ptype.property`.
const KEYWORD = /[a-z0-9_-]/i;
const NAME = /[a-z0-9_.-]/i;

class Scanner {
  private at = 0;

  constructor(private readonly text: string) {}

  authenticationResults(): AuthenticationResults {
    this.skipSpace();
    const authservId = this.value();
    this.skipSpace();
    if (!this.atEnd() && this.peek() !== ';') {
      // An authres-version is the only word allowed here.
      if (!/^\d+$/.test(this.value())) throw new Unreadable();
      this.skipSpace();
    }
    const methods: MethodResult[] = [];
    while (!this.atEnd()) {
      this.expect(';');
      this.skipSpace();
      if (this.atEnd() || this.peek() === ';') continue;
      if (methods.length === 0 && this.noResult()) continue;
      methods.push(this.resultInfo());
    }
    return { authservId, methods };
  }

  /** `method[/version] = result` and its properties, up to `;` or the end. */
  private resultInfo(): MethodResult {
    const method = this.run(KEYWORD).toLowerCase();
    this.skipSpace();
    if (this.peek() === '/') {
      this.at++;
      this.skipSpace();
      if (!/^\d+$/.test(this.run(KEYWORD))) throw new Unreadable();
      this.skipSpace();
    }
    this.expect('=');
    this.skipSpace();
    const result = this.run(KEYWORD).toLowerCase();
    const properties = new Map<string, string>();
    for (;;) {
      this.skipSpace();
      if (this.atEnd() || this.peek() === ';') break;
      const name = this.run(NAME).toLowerCase();
      this.skipSpace();
      this.expect('=');
      this.skipSpace();
      const value = this.value().toLowerCase();
      const earlier = properties.get(name);
      if (earlier !== undefined && earlier !== value) throw new Unreadable();
      properties.set(name, value);
    }
    return { method, result, properties };
  }

  /**
   * A token or quoted string, or a local-part (quoted or not) `@` a domain:
   * everything up to whitespace, a comment, `;` or the end, quoted strings
   * unquoted. An unquoted `=` belongs to it (an address may hold one).
   */
  private value(): string {
    let out = '';
    while (!this.atEnd()) {
      const ch = this.peek();
      if (WHITESPACE.has(ch) || ch === ';' || ch === '(') break;
      if (ch === ')') throw new Unreadable();
      if (ch === '"') {
        out += this.quoted();
      } else {
        out += ch;
        this.at++;
      }
    }
    if (out === '') throw new Unreadable();
    return out;
  }

  private quoted(): string {
    this.at++;
    let out = '';
    for (;;) {
      if (this.atEnd()) throw new Unreadable();
      const ch = this.text[this.at++];
      if (ch === '"') return out;
      if (ch === '\\') {
        if (this.atEnd()) throw new Unreadable();
        out += this.text[this.at++];
      } else {
        out += ch;
      }
    }
  }

  /** Whitespace and `(...)` comments, nested and with escapes. */
  private skipSpace(): void {
    while (!this.atEnd()) {
      const ch = this.peek();
      if (WHITESPACE.has(ch)) this.at++;
      else if (ch === '(') this.skipComment();
      else return;
    }
  }

  private skipComment(): void {
    let depth = 0;
    do {
      if (this.atEnd()) throw new Unreadable();
      const ch = this.text[this.at++];
      if (ch === '\\') {
        if (this.atEnd()) throw new Unreadable();
        this.at++;
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
      }
    } while (depth > 0);
  }

  /** RFC 8601's `none`: the server checked nothing. */
  private noResult(): boolean {
    const end = this.at + 'none'.length;
    if (this.text.slice(this.at, end).toLowerCase() !== 'none') return false;
    const next = this.text[end];
    if (
      next !== undefined &&
      !WHITESPACE.has(next) &&
      next !== '(' &&
      next !== ';'
    ) {
      return false;
    }
    this.at = end;
    this.skipSpace();
    return true;
  }

  private run(allowed: RegExp): string {
    const start = this.at;
    while (!this.atEnd() && allowed.test(this.peek())) this.at++;
    if (this.at === start) throw new Unreadable();
    return this.text.slice(start, this.at);
  }

  private expect(ch: string): void {
    if (this.peek() !== ch) throw new Unreadable();
    this.at++;
  }

  private peek(): string {
    return this.text[this.at];
  }

  private atEnd(): boolean {
    return this.at >= this.text.length;
  }
}

function isFastmail(authservId: string): boolean {
  const id = authservId.toLowerCase();
  return (
    isDomainName(id) &&
    (id === FASTMAIL_AUTHSERV || id.endsWith(`.${FASTMAIL_AUTHSERV}`))
  );
}

/**
 * The methods whose pass vouches for the From, each with the property
 * naming the domain it vouched for. DMARC's `header.from` is the From's own
 * domain, so it must be equal; a DKIM signer need only be aligned.
 */
const VOUCHERS: ReadonlyMap<string, { property: string; exact: boolean }> =
  new Map([
    ['dkim', { property: 'header.d', exact: false }],
    ['dmarc', { property: 'header.from', exact: true }],
  ]);

/**
 * A vouching method named twice with different results fails closed,
 * whichever one is real (#706). Two DKIM signatures with one failing are
 * refused too: an accepted false refusal, since a hand-forward carries its
 * mailbox provider's one signature.
 */
function hasConflict(methods: readonly MethodResult[]): boolean {
  const seen = new Map<string, string>();
  for (const { method, result } of methods) {
    if (!VOUCHERS.has(method)) continue;
    const earlier = seen.get(method);
    if (earlier !== undefined && earlier !== result) return true;
    seen.set(method, result);
  }
  return false;
}

function vouchesFor(methods: readonly MethodResult[], domain: string): boolean {
  return methods.some(({ method, result, properties }) => {
    const voucher = VOUCHERS.get(method);
    if (!voucher || result !== 'pass') return false;
    const vouched = properties.get(voucher.property);
    if (!vouched || !isDomainName(vouched)) return false;
    return voucher.exact ? vouched === domain : aligned(vouched, domain);
  });
}

/** Two or more LDH labels: never an address or a quoted local-part. */
function isDomainName(value: string): boolean {
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(
    value,
  );
}

/** An address's domain, lower case. */
function domainOf(address: string): string | null {
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  return domain || null;
}

function aligned(vouched: string, from: string): boolean {
  return (
    vouched === from ||
    from.endsWith(`.${vouched}`) ||
    vouched.endsWith(`.${from}`)
  );
}
