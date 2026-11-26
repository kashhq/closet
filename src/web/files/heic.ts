import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { HeicDecodeError, type HeicDecoding } from './heic-decoder';

// sharp's bundled libvips has no HEIC decoder, so iPhone photos (and the
// HEIC option on Android) are decoded first and handed to sharp as raw
// RGBA pixels: by heic-decode on HeicDecoder's thread, never on the event
// loop (#699). heic-decode needs the whole container in memory, hence the
// byte cap; its pixels are allocated only after the dimensions are checked
// against the pixel limit sharp applies to every other upload.
//
// Orientation: libheif applies the container's own rotation/mirror
// transforms (irot/imir, which is how iPhones record orientation) while
// decoding, so the pixels are already upright and carry no EXIF for
// sharp's autoOrient() to act on. Stored as decoded.

const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif']);
const HEIC_EXTENSION = /\.hei[cf]$/i;

/** Decoded pixels and the layout sharp needs to read them (`sharp({ raw })`). */
export interface DecodedHeic {
  pixels: Readable;
  raw: { width: number; height: number; channels: 4 };
}

/** An upload with more pixels than Photos accepts, whatever its format. */
export function imageTooLarge(): HttpError {
  return new HttpError(400, t('refusal.upload.tooLarge'));
}

/**
 * Android and desktop browsers sometimes send a HEIC with no better type
 * than application/octet-stream; the file name is the only hint then.
 */
export function isHeicUpload({
  mimetype,
  filename,
}: {
  mimetype: string;
  filename: string;
}): boolean {
  if (HEIC_MIME_TYPES.has(mimetype)) return true;
  return (
    mimetype === 'application/octet-stream' && HEIC_EXTENSION.test(filename)
  );
}

/**
 * The decoder is full, stopping or ran out its deadline: try again shortly
 * (HeicDecoder, 'busy', 'closed' and 'timeout'). A deadline is load (the
 * pixel cap already bounds a hostile file), never a verdict on the photo.
 */
function heicBusy(error: HeicDecodeError): HttpError {
  return new HttpError(503, t('SERVER_BUSY'), {
    logDetail: error.message,
    retryAfterSeconds: 5,
  });
}

/**
 * Buffers the stream up to `maxBytes` and decodes its primary image on the
 * decoder's thread. Rejects with a 413 HttpError past the byte cap, with
 * imageTooLarge() past `maxPixels` before any pixel is allocated (a small
 * file can declare a 20000x20000 grid), and with a 503 when the decoder
 * has no room (before the bytes are buffered) or the deadline passes
 * (after); any other HeicDecodeError (undecodable, a crashed thread) is
 * passed through for the caller to map to a client error. The stream is
 * fully drained on every path: an unconsumed multipart part hangs the
 * request (see Photos.storeImage).
 */
export async function decodeHeic(
  stream: Readable,
  maxBytes: number,
  maxPixels: number,
  decoder: HeicDecoding,
): Promise<DecodedHeic> {
  try {
    const { width, height, pixels } = await decoder.decode(
      () => readHeic(stream, maxBytes),
      maxPixels,
    );
    return {
      pixels: Readable.from([pixels]),
      raw: { width, height, channels: 4 },
    };
  } catch (error) {
    if (!(error instanceof HeicDecodeError)) throw error;
    if (error.reason === 'too-large') throw imageTooLarge();
    if (
      error.reason === 'busy' ||
      error.reason === 'closed' ||
      error.reason === 'timeout'
    ) {
      // Refused before `read` ran, or after it buffered: drained either way.
      stream.resume();
      await finished(stream);
      throw heicBusy(error);
    }
    throw error;
  }
}

async function readHeic(stream: Readable, maxBytes: number): Promise<Buffer> {
  const buffer = await readUpTo(stream, maxBytes);
  if (!buffer) {
    throw new HttpError(413, t('refusal.upload.heicTooLarge', { maxBytes }));
  }
  return buffer;
}

// undefined when the stream exceeds the cap. The loop never breaks early:
// leaving a for-await destroys the stream, and busboy must see the part end.
async function readUpTo(
  stream: Readable,
  maxBytes: number,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (overflow) continue;
    size += chunk.length;
    if (size > maxBytes) {
      overflow = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk);
  }
  return overflow ? undefined : Buffer.concat(chunks);
}
