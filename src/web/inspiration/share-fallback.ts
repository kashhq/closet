import type { FastifyRequest } from 'fastify';
import { formParts } from '../form-body';
import { HttpError } from '../errors';
import { LINK_INPUT_MAX } from '../wardrobe/link-import/link-text';
import {
  linkPageFor,
  SHARE_BODY_MAX_BYTES,
  SHARE_CONFIRM_PATH,
  SHARE_NOT_OPENED,
  SHARE_PHOTO_FIELD,
  SHARE_PHOTO_MAX_BYTES,
  SHARED_TEXT_FIELDS,
} from './share-target';

export type ShareFallbackOutcome =
  /** A photo: the server cannot keep it without writing, so share again. */
  | 'photo'
  /** No photo, a link or text: the link page, like the worker's answer. */
  | 'link'
  | 'text'
  /** Nothing to go on (or not a form): share again from the open app. */
  | 'empty';

const isSharedField = (
  name: string,
): name is (typeof SHARED_TEXT_FIELDS)[number] =>
  (SHARED_TEXT_FIELDS as readonly string[]).includes(name);

/**
 * POST /inspiration/share when no service worker answered it (#22d;
 * share-target.ts). It **writes nothing**: the route is the same-origin
 * hook's one `stateless` exemption (src/web/security/same-origin.ts), so a
 * cross-site page can reach it, and all it may do is choose a redirect that
 * page could have linked to. It reads only the share's text fields, each cut
 * at LINK_INPUT_MAX, and stops at the photo, whose bytes it never reads; a
 * body declared past SHARE_BODY_MAX_BYTES is a 413 before any of it is read,
 * and an undeclared one is held to busboy's limits.
 */
export async function shareFallback(
  request: FastifyRequest,
): Promise<{ outcome: ShareFallbackOutcome; path: string }> {
  if (Number(request.headers['content-length']) > SHARE_BODY_MAX_BYTES) {
    throw new HttpError(413);
  }
  const shareAgain = (outcome: 'photo' | 'empty') => ({
    outcome,
    path: `${SHARE_CONFIRM_PATH}#${SHARE_NOT_OPENED}`,
  });
  if (!request.isMultipart()) return shareAgain('empty');
  const { fields, photo } = await readShare(request);
  if (photo) return shareAgain('photo');
  const url = fields.get('url') ?? '';
  const text = fields.get('text') ?? '';
  if (!`${url}${text}`.trim()) return shareAgain('empty');
  return linkPageFor(url, text);
}

/**
 * The share's text fields, until its photo: leaving the loop there ends
 * the iterator, so the rest of the body, the photo's bytes included, is
 * never read. Another file is drained to nothing, under the size cap.
 */
async function readShare(
  request: FastifyRequest,
): Promise<{ fields: Map<string, string>; photo: boolean }> {
  const fields = new Map<string, string>();
  const parts = formParts(request, {
    limits: {
      fields: SHARED_TEXT_FIELDS.length,
      fieldSize: LINK_INPUT_MAX,
      fileSize: SHARE_PHOTO_MAX_BYTES,
      files: 4,
    },
  });
  for await (const part of parts) {
    if (part.type === 'field') {
      if (isSharedField(part.fieldname) && typeof part.value === 'string') {
        fields.set(part.fieldname, part.value);
      }
    } else if (
      part.fieldname === SHARE_PHOTO_FIELD &&
      part.mimetype.startsWith('image/')
    ) {
      return { fields, photo: true };
    } else {
      part.file.resume();
    }
  }
  return { fields, photo: false };
}
