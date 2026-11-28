import type { FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';

/**
 * Every response's Content-Security-Policy (#672), built once per process
 * (createApp's root onSend hook), so it costs a request nothing, the bearer
 * surfaces included. `importMap` is the very string every page renders:
 * createApp makes it once (`importMapScript`) and hands the same value to
 * this and to the page context (`ViewContext.importMap`, which the layout
 * writes as is), so the hash and the page cannot name different texts.
 *
 * No inline script runs: the importmap is the page's one inline script
 * (external import maps are not a thing), allowed by its exact text's
 * sha256, which is fixed per build. Never a per-response nonce: it would
 * change every page's bytes (the stale-while-revalidate tab roots' compare
 * and the page's ETag, #708), a 304 the worker confirms a stored copy with
 * carries the new header over the old body (`confirmedHeaders`), and a
 * boosted navigation's scripts would need htmx's `inlineScriptNonce`, which
 * stamps any script a swap carries. A page's behaviour is a data-* name a
 * head module reads (actions.ts, page-mount.ts).
 *
 *  - style-src keeps 'unsafe-inline': the `style` attributes and daisyUI's
 *    (out of scope for #672).
 *  - img-src blob:: the mask editor draws the original and the cutout from
 *    object URLs. No blob: scripts or workers.
 *  - No eval (htmx's `allowEval` is off; hx-on, js: values and trigger
 *    filters are unused).
 *  - base-uri, form-action and object-src do not fall back to default-src.
 *  - form-action is 'self' alone, but on a response allowFormTarget widened
 *    (below): `formTarget`, an origin, beside it.
 */
export function contentSecurityPolicy(
  importMap: string,
  formTarget?: string,
): string {
  const hash = createHash('sha256').update(importMap).digest('base64');
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'sha256-${hash}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    formTarget === undefined
      ? "form-action 'self'"
      : `form-action 'self' ${formTarget}`,
    "object-src 'none'",
  ];
  return `${directives.join('; ')};`;
}

const formTargets = new WeakMap<FastifyReply, string>();

/**
 * Lets this response's forms end at `target`'s origin as well as this
 * site's: Chromium holds the redirects after a submission to form-action,
 * so the OAuth consent's POST, whose 303 goes to the client's redirect URI,
 * would be blocked by 'self' alone (#1290; plan 4.4). Only the consent page
 * calls it, with the redirect URI it proved; createApp's onSend builds the
 * header from it (formTargetOf), every other response keeps the one CSP.
 * The origin comes from the URL parser alone, so no character of the URI a
 * client wrote reaches the header but its scheme, host and port: an opaque
 * origin (`null`) or anything else is refused.
 */
export function allowFormTarget(reply: FastifyReply, target: URL): void {
  formTargets.set(reply, formTargetOrigin(target));
}

/** `target`'s origin as a CSP source, or a throw. Exported for its spec. */
export function formTargetOrigin(target: URL): string {
  const { origin } = target;
  if (!/^https?:\/\/[a-z0-9.\-[\]:]+$/.test(origin)) {
    throw new Error('A form target must have an http(s) origin');
  }
  return origin;
}

/** The origin allowFormTarget gave this response, if any. */
export function formTargetOf(reply: FastifyReply): string | undefined {
  return formTargets.get(reply);
}
