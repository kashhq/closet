# HTTP/2 in the outbound fetcher, so Shopify product pages load (#496)

Status: recommendations adopted by the coordinator 2026-11-13 under the owner's standing instruction to keep building on plan recommendations (decision to build: owner, 2026-11-12); the owner may veto any decision below.

## 1. Why

#347 found Shopify storefronts answer our HTTP/1.1 client with a 429 and `Retry-After`. The same pages load over HTTP/2. Today they are `blocked-by-site`, and Muse's retailer suggestions skip them. The 429 is a protocol-level policy of the shop's CDN, not a content rule.

## 2. How the fetcher connects today (`src/web/security/outbound-fetch.ts`)

- `pin()` checks scheme, default port, no URL credentials and the `hosts` allow-list, resolves the name once, refuses if **any** answer fails `isPublicAddress`, and picks one address (IPv4 first).
- `send()` calls `http.request` or `https.request` with `lookup: pinnedLookup(address)` (no second DNS query), `agent: false` (a fresh socket per request), `servername = host` for SNI and the certificate check, and one `AbortSignal.timeout(10 s)` over the whole chain.
- `fetchFollowing()` runs `pin()` then `send()` per hop: at most 3 redirects, each hop re-resolved and re-checked. A request with a credential or JSON body follows none.
- `readResponse()`: status refusal (`blocked-by-site`, `http-status`), content type allow-list, then `decoded()` (gzip, deflate, br) feeds `readCapped()`, which counts **decoded** bytes: images and JSON past the cap are refused, a page is cut at 2 MB. The stream is destroyed the moment the cap passes.
- Everything downstream sees a Node `IncomingMessage` (`statusCode`, `headers`, a Readable).

## 3. Design

### 3.1 One TLS dial, then pick the protocol by ALPN

Node's `http2.connect` cannot fall back to HTTP/1.1, so the fetcher dials itself:

1. For an `https:` hop, `tls.connect({ host: <checked address>, port, servername: <name>, ALPNProtocols: ['h2', 'http/1.1'], signal })`. The address is the one `pin()` checked, so the pinned lookup's guarantee holds by construction: nothing resolves a name here. `servername` keeps SNI and certificate verification on the name (an IP literal host gets no servername, as today).
2. On `secureConnect`, read `socket.alpnProtocol`:
   - `'h2'`: `http2.connect(origin, { createConnection: () => socket, enablePush: false })`, one `session.request(...)`.
   - anything else (`'http/1.1'`, or none): the existing `https.request` with `createConnection: () => socket` and `agent: false`. The 1.1 path is unchanged except that it receives the already-connected socket; no second dial.
3. Plain `http:` hops stay HTTP/1.1 (no h2c: browsers do not, and no shop serves it).

No setting turns this off in production. A kill switch is an env var for one release only if the owner wants it (section 8).

### 3.2 A transport-neutral answer

`send()` returns today's `IncomingMessage`. HTTP/2 gives `:status` and a stream. The module introduces one internal `Answer { status, headers (lower-case, string or string[]), body: Readable, destroy() }`; the 1.1 path adapts `IncomingMessage` into it, the h2 path adapts the stream. `fetchFollowing`, `refuseStatus`, `isChallenge`, `decoded` and `readCapped` take an `Answer` and do not know the protocol. This is the only refactor of existing code, and it keeps one copy of every refusal rule (no h2 branch of them).

### 3.3 Guarantees, one by one

- **Address checks on every hop**: unchanged, `pin()` runs before every dial. A redirect is a **new session** to that hop's checked address; sessions are never reused across hops or requests, so no session can carry another hop's pin (h2 coalescing by certificate or IP cannot happen).
- **Redirect limit and `hosts`**: unchanged, they live in `fetchFollowing`.
- **Timeout and abort**: the same signal passed to `tls.connect`, and an `abort` listener that `destroy()`s the stream and the session (RST_STREAM then socket close). `readCapped`'s `signal.throwIfAborted()` stays, since an aborted stream can end quietly here too.
- **Decoded byte caps**: the h2 stream is a Readable of the same content-encoded bytes; `decoded()` and `readCapped()` run on it unchanged. A cap hit calls `destroy()` on the **session**, not just the stream, so a server cannot keep sending DATA frames. The declared `content-length` pre-check stays only as an early refusal, never the guard: the counted bytes are. h2 servers can lie about it, and Node does not enforce the match on a client stream (spec in section 5).
- **Session lifetime**: one request per session; `session.close()` after the stream ends and `destroy()` on every error and abort path (a `finally` beside `readResponse`'s). A session holds no state after the fetch; `maxSessionMemory` and `enablePush: false` bound a hostile server (no server push, no extra streams).
- **No cookies, no credentials leakage**: same headers, same rule that `authorization` goes only to a request naming `hosts`.
- **Logging**: the one fetch line gains the protocol (`h2` or `http/1.1`), still hosts only, never path or query.

### 3.4 Headers

HTTP/2 puts method, path, scheme and authority in pseudo-headers (`:method`, `:path`, `:scheme`, `:authority`, from the URL; `:authority` is the Host the 1.1 path sends). The regular headers are the same set, lower-cased: `user-agent`, `accept`, `accept-encoding`, `accept-language`, plus `authorization`, `content-type` and `content-length` for the JSON POST. `connection`, `keep-alive` and `transfer-encoding` are never sent (forbidden in h2). A POST body is written with `stream.end(body)`.

### 3.5 Why this is not evasion

#347 refused two things on purpose: a browser User-Agent and defeating challenges. This plan does neither. The honest `Mozilla/5.0 (compatible; Closet/1.0; +link import)` UA is unchanged, and Cloudflare and AWS WAF challenges, 403s and 429s stay `blocked-by-site`. HTTP/2 is the transport every browser and most HTTP clients speak; an HTTP/1.1-only client is the unusual one, and a shop that serves h2 clients and 429s h1 ones is rate-limiting by protocol quirk, not by identity. If a shop still blocks us over h2, the refusal stands. A guard test pins the UA string so a later change cannot slip a browser's in.

## 4. Test fixture

`test/integration/link-sites.ts` serves plain HTTP on 127.0.0.2. Add, beside it:

- A **TLS server** on 127.0.0.2 (`http2.createSecureServer({ allowHTTP1: true })`, ALPN `h2` then `http/1.1`), with a throwaway self-signed certificate for `shop.test` and `www.shop.test` generated at test start (no key committed, `node:crypto` plus a short in-process cert builder, or `openssl` in globalSetup if the repo already shells out to it).
- **Trusted only in tests**: `createOutboundFetcher` gains a test-only `tls: { ca }` option (like `destinations` and `resolve`, documented "for specs only"), passed to `tls.connect`. The production code path never reads it, and `config.ts` does not expose it. `NODE_TLS_REJECT_UNAUTHORIZED` is never touched.
- A `protocol: 'h2' | 'http/1.1'` option on `startLinkSites()` (so the server offers only ALPN `http/1.1` to test the fallback), and a recorded `alpn` per hit.
- `serve()` and `Page` keep their shape; existing specs keep running on plain HTTP and need no change.

## 5. Specs (`test/integration/outbound-fetch.spec.ts`, in `ci-db`'s budget; no Playwright)

Over h2: success (an HTML page, an image, a gzip and a br body, JSON POST to a `hosts` API); fallback (server offers only `http/1.1`: same page, logged `http/1.1`); the Shopify case (the server 429s any HTTP/1.1 client and serves h2: h2 loads, `blocked-by-site` stays for a genuine 429 over h2). Every existing refusal over h2: a private address and a name resolving to one (no TLS connect attempted: assert on the server's connection count), a redirect to a private address and to a disallowed host, too many redirects (each hop a distinct session: assert distinct session counts), an image over the cap, a page cut at 2 MB, `blocked-by-site` (403, 429, a challenge header), `unexpected-content-type`, timeout (a stalled h2 stream, and a stalled handshake) and abort leaving no open session. And an h2 server that **lies about content-length** (declares 1 KB, sends 3 MB; declares 3 MB, sends 1 KB): the cap and the body are the counted bytes. The DNS-rebinding spec gets an h2 twin (the resolver answers differently on a second call; the second must never be asked).

## 6. Slices

- **496a:** the `Answer` refactor with HTTP/1.1 only (behavior-neutral; existing specs prove it), plus the TLS dial and ALPN pick with the h1.1 path on the dialed socket, and the fixture's TLS server.
- **496b:** the h2 transport, its specs, the log's protocol field, the AGENTS.md and decisions entries (security AGENTS.md's outbound bullet, link-import AGENTS.md's Shopify note, the 2026-11-12 entry's consequence line superseded by a new dated one).
- **496c:** a real-world check against one Shopify storefront and one Cloudflare site by hand (not in CI), recorded in the issue.

## 7. Risks

- **A hostile h2 server** (rapid reset, header floods, huge SETTINGS, many streams): one stream per session, no push, `maxSessionMemory`, header-list limits, the 10 s timeout, and the cap's `destroy()` of the session. Node's `http2` has had CVEs (rapid reset, 2023); the Node 22 pin tracks patches.
- **Memory**: h2 flow-control windows buffer ahead of our reads. The default 64 KB window keeps it small; confirm we do not raise it.
- **A new surface sharing the cap code**: mitigated by section 3.2 (one copy of the rules) and the lying-server spec.
- **Shops stay blocked** over h2 (a challenge, a TLS-fingerprint rule): the outcome is unchanged `blocked-by-site`, no regression. We cannot know the gain before 496c.
- **Plain TLS-only claim**: a server negotiating `h2` on a connection we dialed to a checked address is the only thing that changes; the SSRF boundary stays the dial.

## 8. Owner decisions (recommendations)

1. **Fallback to HTTP/1.1 when ALPN does not pick h2.** Recommend yes: most sites are fine on 1.1 and a broken h2 server should not lose imports.
2. **Test-only `tls.ca` option** vs a global test CA in env. Recommend the option: explicit, spec-only, never production-reachable.
3. **A kill switch env var** (`OUTBOUND_HTTP2=false`). Recommend no: one more branch to test, and the fallback already covers a server that does not speak h2; revert the PR if h2 misbehaves.
4. **h2c (cleartext) and session reuse across requests.** Recommend neither, as above: pinning and per-hop checks are simpler to trust with one session per request.
5. **Keep the honest UA.** Recommend yes, unchanged, and enforced by a test.
