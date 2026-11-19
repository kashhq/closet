/**
 * The Server-Timing entry that repeats a page's ETag (src/web/render.ts,
 * src/metrics/request-timing.ts writes it), its opaque value without `W/`
 * or quotes, for the one reader that cannot see the header: a document's
 * own script, through Navigation Timing. freshness.ts (views/assets/page/)
 * sends it back as If-None-Match after a sync, so an unchanged page answers
 * 304 and offers nothing (#900).
 */
export const PAGE_TAG_TIMING_NAME = 'etag';
