import { Type } from '@sinclair/typebox';
import type { ShareableKind } from './queries';

/**
 * A shared item's public link, its /share page (routes.tsx) on `origin`:
 * SITE_URL wherever the link is handed out to be sent on (the page's
 * "Shared publicly" panel, the API's `publicShareUrl`), the request's own
 * origin for the page's Open Graph `og:url`.
 */
export function publicShareUrl(
  origin: string,
  type: ShareableKind,
  shareableId: string,
): string {
  const params = new URLSearchParams({ shareableId, type });
  return `${origin}/share?${params}`;
}

/** `publicShareUrl` on the API's garment and outfit resources, and the answer of PUT .../share (#959). */
export const PublicShareUrl = Type.String({
  format: 'uri',
  description:
    "Its public link (#669): anyone with it sees the item, signed out. Absolute, on the server's public address (SITE_URL), to be sent on as it is; absent while not shared",
});

/** The answer of a Share through the API (PUT /garments/{id}/share, /outfits/{id}/share). */
export const PublicShare = Type.Object(
  { publicShareUrl: PublicShareUrl },
  {
    title: 'PublicShare',
    description:
      'Shared publicly: the link to send. Sharing what is shared already answers the same link',
  },
);
