import { describe, expect, it } from 'vitest';
import { judgeSender, parseAuthenticationResults } from './trust';

const OWNER = 'owner@gmail.com';
const FASTMAIL_PASS =
  'mx6.messagingengine.com; arc=none (no signatures); dkim=pass (2048-bit rsa key sha256) header.d=gmail.com header.i=@gmail.com header.b=Xk3p; dmarc=pass (p=none) header.from=gmail.com; spf=pass smtp.mailfrom=owner@gmail.com smtp.helo=mail-wr1-f54.google.com';
/** Every piece Fastmail's MX writes (test/fixtures/order-mail/forwarded-order.json). */
const FASTMAIL_REAL =
  'mx6.messagingengine.com; arc=none (no signatures); dkim=pass (2048-bit rsa key sha256) header.d=gmail.com header.i=@gmail.com header.b=Xk3pQ2aB header.a=rsa-sha256 header.s=20230601 x-bits=2048; dmarc=pass policy.published-domain-policy=none (p=none,sp=quarantine,d=none,d.eval=none) policy.policy-from=p header.from=gmail.com; iprev=pass smtp.remote-ip=209.85.221.54 (mail-wr1-f54.google.com); spf=pass smtp.mailfrom=owner.forwarder@gmail.com smtp.helo=mail-wr1-f54.google.com; x-aligned-from=pass (Address match); x-google-dkim=pass (2048-bit rsa key) header.d=1e100.net header.i=@1e100.net header.b=Rt5sYw1c; x-me-sender=none; x-tls=pass smtp.version=TLSv1.3 smtp.cipher=TLS_AES_256_GCM_SHA384 smtp.bits=256/256; x-vs=clean score=-100 state=0';

const judge = (from: string | null, results: string[], allowed = [OWNER]) =>
  judgeSender(
    {
      from: from === null ? null : [{ email: from }],
      authenticationResults: results,
    },
    allowed,
  );

describe('judgeSender', () => {
  it("trusts the owner's forward that Fastmail authenticated, in any case", () => {
    expect(judge('Owner@Gmail.com', [FASTMAIL_PASS])).toEqual({
      trusted: true,
      sender: OWNER,
    });
  });

  it.each([
    [
      'DKIM alone',
      'mx1.messagingengine.com; dkim=pass header.d=gmail.com; spf=fail smtp.mailfrom=gmail.com',
    ],
    [
      'DMARC alone',
      'mx1.messagingengine.com; dkim=fail header.d=gmail.com; dmarc=pass header.from=gmail.com',
    ],
    [
      'a signing subdomain',
      'mx1.messagingengine.com; dkim=pass header.d=mail.gmail.com',
    ],
    [
      'two passing signatures',
      'mx1.messagingengine.com; dkim=pass header.d=gmail.com; dkim=pass header.d=esp.example',
    ],
    [
      'a method it does not read repeated with two results',
      'mx1.messagingengine.com; dkim=pass header.d=gmail.com; x-return-mx=pass header.domain=gmail.com; x-return-mx=fail smtp.domain=relay.example',
    ],
    [
      'a version, folded lines and a quoted reason',
      'mx1.messagingengine.com 1;\r\n\tdkim=pass reason="good; signature" header.d=gmail.com',
    ],
    ["Fastmail's real header", FASTMAIL_REAL],
  ])('passes on %s', (_, results) => {
    expect(judge(OWNER, [results]).trusted).toBe(true);
  });

  it.each([
    ['no From', null, [FASTMAIL_PASS], 'no-single-sender'],
    ['a stranger', 'deals@shop.example', [FASTMAIL_PASS], 'sender-not-allowed'],
    ['no Authentication-Results', OWNER, [], 'no-authentication-results'],
    [
      "a result under another server's name",
      OWNER,
      ['mx.evil.example; dkim=pass header.d=gmail.com'],
      'foreign-authserv',
    ],
    [
      'a name that only ends like Fastmail',
      OWNER,
      ['evilmessagingengine.com; dkim=pass header.d=gmail.com'],
      'foreign-authserv',
    ],
    [
      'failures at Fastmail, whatever the sender added below',
      OWNER,
      [
        'mx2.messagingengine.com; dkim=none; dmarc=fail header.from=gmail.com; spf=softfail smtp.mailfrom=owner@gmail.com',
        FASTMAIL_PASS,
      ],
      'authentication-failed',
    ],
    [
      "a pass for another domain (the sender's own)",
      OWNER,
      [
        'mx1.messagingengine.com; dkim=pass header.d=evil.example; spf=pass smtp.mailfrom=bounce@evil.example',
      ],
      'authentication-failed',
    ],
    [
      'a pass for a domain that only ends like the owner’s',
      OWNER,
      ['mx1.messagingengine.com; dkim=pass header.d=xgmail.com'],
      'authentication-failed',
    ],
    [
      'a pass named only in a comment',
      OWNER,
      [
        'mx1.messagingengine.com; dkim=fail (dkim=pass header.d=gmail.com) header.d=gmail.com',
      ],
      'authentication-failed',
    ],
    [
      'SPF alone: it vouches for the envelope sender, whom the sender picks',
      OWNER,
      [
        'mx1.messagingengine.com; dkim=none; spf=pass smtp.mailfrom=owner@gmail.com',
      ],
      'authentication-failed',
    ],
    [
      "DMARC for a domain other than the From's, even its subdomain",
      OWNER,
      ['mx1.messagingengine.com; dmarc=pass header.from=mail.gmail.com'],
      'authentication-failed',
    ],
    [
      "a header another hop added above Fastmail's",
      OWNER,
      ['mx.relay.example; dkim=pass header.d=gmail.com', FASTMAIL_PASS],
      'foreign-authserv',
    ],
    [
      'an authserv-id that is not a host name',
      OWNER,
      ['"x mx1.messagingengine.com"; dkim=pass header.d=gmail.com'],
      'foreign-authserv',
    ],
  ])('refuses %s', (_, from, results, reason) => {
    expect(judge(from, results)).toMatchObject({ trusted: false, reason });
  });

  // #706: what a sender chooses (the envelope's local-part, a signature's
  // header.i) reaches Fastmail's own header, and no `;`, `=` or `(` in it
  // may end a piece. Each is the owner's From at Fastmail, with only the
  // attacker's own domain really passing.
  it.each([
    [
      'a quoted smtp.mailfrom carrying a DKIM pass',
      'mx1.messagingengine.com; dkim=pass header.d=evil.example; spf=pass smtp.mailfrom="x; dkim=pass header.d=gmail.com y"@evil.example',
      'authentication-failed',
    ],
    [
      'a quoted header.i carrying a DMARC pass',
      'mx1.messagingengine.com; dkim=pass header.d=evil.example header.i="a; dmarc=pass header.from=gmail.com"@evil.example',
      'authentication-failed',
    ],
    [
      'escaped quotes inside a quoted value',
      String.raw`mx1.messagingengine.com; spf=pass smtp.mailfrom="a\"; dkim=pass header.d=gmail.com; b=\""@evil.example`,
      'authentication-failed',
    ],
    [
      'an unquoted `=` in the local-part',
      'mx1.messagingengine.com; spf=pass smtp.mailfrom=dkim=pass@evil.example',
      'authentication-failed',
    ],
    [
      'a comment holding a `;` and a pass',
      'mx1.messagingengine.com; dkim=pass (ok; dmarc=pass header.from=gmail.com) header.d=evil.example',
      'authentication-failed',
    ],
    [
      'nested comments',
      'mx1.messagingengine.com; dkim=fail (a (b) ; dkim=pass header.d=gmail.com) header.d=gmail.com',
      'authentication-failed',
    ],
    [
      'an escaped parenthesis in a comment',
      String.raw`mx1.messagingengine.com; dkim=fail (x \) ; dkim=pass header.d=gmail.com) header.d=gmail.com`,
      'authentication-failed',
    ],
    [
      'an unterminated quote',
      'mx1.messagingengine.com; spf=pass smtp.mailfrom="x; dkim=pass header.d=gmail.com',
      'unreadable-authentication-results',
    ],
    [
      'an unterminated comment',
      'mx1.messagingengine.com; dkim=fail (x; dkim=pass header.d=gmail.com',
      'unreadable-authentication-results',
    ],
    [
      'a stray closing parenthesis',
      'mx1.messagingengine.com; dkim=fail header.d=x) ; dkim=pass header.d=gmail.com',
      'unreadable-authentication-results',
    ],
    [
      'a property named twice with two values',
      'mx1.messagingengine.com; dkim=pass header.d=evil.example header.d=gmail.com',
      'unreadable-authentication-results',
    ],
    [
      'a header past the length cap, which is refused, never cut',
      `mx1.messagingengine.com; dkim=pass header.d=gmail.com; x=none${' (pad)'.repeat(3000)}; dkim=fail`,
      'unreadable-authentication-results',
    ],
    [
      'DKIM named twice with two results',
      'mx1.messagingengine.com; dkim=fail header.d=gmail.com; dkim=pass header.d=gmail.com',
      'conflicting-results',
    ],
    [
      'DMARC named twice with two results',
      'mx1.messagingengine.com; dmarc=pass header.from=gmail.com; dmarc=fail header.from=gmail.com',
      'conflicting-results',
    ],
  ])('refuses %s', (_, results, reason) => {
    expect(judge(OWNER, [results])).toMatchObject({ trusted: false, reason });
  });

  it('refuses a From with two addresses, even when one is the owner', () => {
    expect(
      judgeSender(
        {
          from: [{ email: OWNER }, { email: 'other@example.com' }],
          authenticationResults: [FASTMAIL_PASS],
        },
        [OWNER],
      ),
    ).toMatchObject({ trusted: false, reason: 'no-single-sender' });
  });

  it('names only the domain of a refused sender', () => {
    expect(judge('deals@shop.example', [FASTMAIL_PASS])).toEqual({
      trusted: false,
      reason: 'sender-not-allowed',
      domain: 'shop.example',
    });
  });
});

describe('parseAuthenticationResults', () => {
  it('reads the authserv-id, each method and its properties, without comments', () => {
    const parsed = parseAuthenticationResults(FASTMAIL_PASS)!;
    expect(parsed.authservId).toBe('mx6.messagingengine.com');
    expect(
      parsed.methods.map(({ method, result, properties }) => [
        method,
        result,
        Object.fromEntries(properties),
      ]),
    ).toEqual([
      ['arc', 'none', {}],
      [
        'dkim',
        'pass',
        {
          'header.d': 'gmail.com',
          'header.i': '@gmail.com',
          'header.b': 'xk3p',
        },
      ],
      ['dmarc', 'pass', { 'header.from': 'gmail.com' }],
      [
        'spf',
        'pass',
        {
          'smtp.mailfrom': 'owner@gmail.com',
          'smtp.helo': 'mail-wr1-f54.google.com',
        },
      ],
    ]);
  });

  it("reads Fastmail's real header whole, and `none`", () => {
    expect(
      parseAuthenticationResults(FASTMAIL_REAL)?.methods.map(
        ({ method }) => method,
      ),
    ).toEqual([
      'arc',
      'dkim',
      'dmarc',
      'iprev',
      'spf',
      'x-aligned-from',
      'x-google-dkim',
      'x-me-sender',
      'x-tls',
      'x-vs',
    ]);
    for (const header of [
      'mx1.messagingengine.com; none',
      'mx1.messagingengine.com; none;',
    ]) {
      expect(parseAuthenticationResults(header)).toEqual({
        authservId: 'mx1.messagingengine.com',
        methods: [],
      });
    }
  });

  it('keeps a quoted value whole, unquoted', () => {
    const [spf] =
      parseAuthenticationResults(
        String.raw`mx1.messagingengine.com; spf=pass smtp.mailfrom="a; b=\"c\""@evil.example`,
      )?.methods ?? [];
    expect(spf.properties.get('smtp.mailfrom')).toBe('a; b="c"@evil.example');
  });

  it('is null, never a throw or a partial answer, for a garbled header', () => {
    for (const header of [
      '',
      ';;;',
      '(((',
      'x; =pass',
      'x; dkim',
      'x; dkim=pass header.d',
      'x; dkim=pass stray',
      'x version; dkim=pass',
      'x; dkim=pass header.d="a\\',
      `a; ${'dkim=pass '.repeat(5000)}`,
    ]) {
      expect(parseAuthenticationResults(header)).toBeNull();
    }
  });
});
