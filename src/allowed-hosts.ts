/**
 * The names this server answers to (#702): a request addressed to any other
 * Host is a DNS-rebinding page (attacker.example resolving to this server's
 * address), whose Host and Origin agree, so the same-origin check alone
 * passes it. Shared by loadConfig (ALLOWED_HOSTS' rule, the list it derives
 * from SITE_URL) and the root hook that refuses the rest
 * (src/web/security/allowed-host.ts).
 */

/**
 * Loopback, at any port, is always allowed: the image's HEALTHCHECK and the
 * smoke test call 127.0.0.1, the dev server and Playwright localhost. A
 * rebinding page cannot be addressed by these names.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// What a Host value or an ALLOWED_HOSTS entry may never carry: a path,
// query, fragment, userinfo or whitespace would make `new URL` read
// something other than an authority.
const NOT_AN_AUTHORITY = /[/?#@\\\s]/;

interface Authority {
  /** Lower-cased; an IDN in its ASCII form, IPv6 in brackets. */
  hostname: string;
  /** Port 80 or 443 dropped (empty), whichever scheme a proxy received it on. */
  port: string;
}

function parseAuthority(raw: string): Authority | undefined {
  const value = raw.trim();
  if (value === '' || NOT_AN_AUTHORITY.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(`http://${value}`);
  } catch {
    return undefined;
  }
  return { hostname: url.hostname, port: url.port === '443' ? '' : url.port };
}

const keyOf = ({ hostname, port }: Authority) =>
  port ? `${hostname}:${port}` : hostname;

/**
 * A `host[:port]` as one comparable key, spelled the way a browser spells
 * a default port (by leaving it out). Undefined for anything that is not an
 * authority.
 */
export function hostKey(raw: string): string | undefined {
  const authority = parseAuthority(raw);
  return authority && keyOf(authority);
}

/** The host key of a URL (SITE_URL), or undefined when it does not parse. */
export function urlHostKey(url: string): string | undefined {
  return URL.canParse(url) ? hostKey(new URL(url).host) : undefined;
}

/**
 * Whether a request's Host is one of `allowed` (host keys) or loopback. An
 * entry with a port matches that port only; one without matches the bare
 * name (or its default port), as SITE_URL's origin does.
 */
export function hostAllowlist(
  allowed: readonly string[],
): (host: string) => boolean {
  const keys = new Set(allowed);
  return (host) => {
    const authority = parseAuthority(host);
    if (authority === undefined) return false;
    return LOOPBACK.has(authority.hostname) || keys.has(keyOf(authority));
  };
}

/**
 * Whether `allowed` (host keys) names nothing but loopback: the server then
 * answers only localhost, as an install still on the default SITE_URL with
 * no ALLOWED_HOSTS does. createApp warns at boot in production.
 */
export function onlyLoopback(allowed: readonly string[]): boolean {
  return allowed.every((key) => {
    const authority = parseAuthority(key);
    return authority !== undefined && LOOPBACK.has(authority.hostname);
  });
}
