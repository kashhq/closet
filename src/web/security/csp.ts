import { createHash } from 'node:crypto';
import { importMapScript } from '../layout/import-map';

/**
 * Every response's Content-Security-Policy (#672), built once per process
 * (createApp's root onSend hook) from the build's asset version, so it
 * costs a request nothing, the bearer surfaces included.
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
 */
export function contentSecurityPolicy(assetVersion: string): string {
  const importMap = createHash('sha256')
    .update(importMapScript(assetVersion))
    .digest('base64');
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'sha256-${importMap}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ];
  return `${directives.join('; ')};`;
}
