import { Readable } from 'node:stream';
import type { Db } from '../../../db/client';
import { HttpError } from '../../errors';
import {
  type ImageSource,
  MAX_INPUT_PIXELS,
  type Photos,
} from '../../files/photos';
import { type StringKey, t, type Translated } from '../../i18n';
import type { Logger } from '../../../logger';
import type { RateLimitChecker } from '../../security/rate-limit';
import {
  type FetchedResource,
  type FetchRequest,
  type OutboundFetcher,
  OutboundFetchError,
  type OutboundFetchRefusal,
} from '../../security/outbound-fetch';
import { keepPendingPhoto } from '../writes';
import { type ExtractedProduct, extractProduct } from './extract';

/**
 * Adding a garment from a link (issue #6; docs/plans/2026-09-26-wardrobe-
 * features.md, section 0): fetch what the link names through the outbound
 * fetcher, the only fetcher of user-supplied URLs, and turn it into what
 * the garment form needs. Nothing here writes a `garment` or `file` row. A
 * photo it keeps is a pending photo: bytes plus a `pending_photo` row bound
 * to the user who fetched it (src/web/files/pending-photos.ts), which the
 * form's save claims (createGarmentWithPendingPhoto, ../writes.ts) or
 * reconciliation removes a day later.
 *
 * Memory: the choices are fetched and previewed CHOICE_CONCURRENCY at a
 * time, and all of them together decode at most CHOICE_PIXEL_BUDGET pixels
 * (previewChoices), so one import holds at most three fetched images of up
 * to 15 MB (BYTE_LIMITS.image: two in flight, and the first readable one
 * kept to store) and two decodes, however many candidates the page names.
 * LINK_IMPORT_LIMIT bounds one user's rate, not how many users import at
 * the same moment.
 *
 * - An image: stored as the pending photo.
 * - A web page: extractProduct, then its image candidates fetched for the
 *   choices (previews in memory, never stored) and the first one that
 *   reads stored as the pending photo, so the form opens with a photo.
 */

/** How many of a page's image candidates are fetched as choices. */
const MAX_PHOTO_CHOICES = 6;

/** How many choices are fetched and previewed at once. */
export const CHOICE_CONCURRENCY = 2;

/**
 * The pixels one import's previews may decode, all its choices together:
 * as many as a single upload may (MAX_INPUT_PIXELS), so a page of six
 * near-limit photos costs what one does, not six times it. A choice past
 * what is left is skipped. Six ordinary product photos (a few MP each) fit
 * several times over.
 */
export const CHOICE_PIXEL_BUDGET = MAX_INPUT_PIXELS;

export type LinkImportRefusal =
  | OutboundFetchRefusal
  /** The text holds no http(s) link. */
  | 'no-link'
  /** Fetched as an image, but not one Photos can decode (or too many pixels). */
  | 'unreadable-image';

/**
 * What an API or agent caller is told of a refusal: the reason leads (a
 * machine-readable word to branch on), then the copy.
 */
export function reasonLed(reason: string, message: string): Translated {
  return t('linkImport.REASON_LED', { reason, message });
}

export function reasonLedMessage(reason: LinkImportRefusal): Translated {
  return reasonLed(reason, t(REFUSALS[reason].message));
}

/** A refusal of the link import's (REFUSALS says what the user is told). */
export class LinkImportError extends Error {
  constructor(readonly reason: LinkImportRefusal) {
    super(`Link import refused: ${reason}`);
    this.name = 'LinkImportError';
  }
}

/**
 * The message a refusal shows, and its status: 400 for a link that is not
 * one the server fetches, 502 for a site that did not give a usable answer.
 * The messages never name a host or an address (a name that resolves
 * inside the network must not tell the user where it points).
 */
export const REFUSALS: Readonly<
  Record<LinkImportRefusal, { message: StringKey; status: 400 | 502 }>
> = {
  'no-link': { message: 'linkImport.NO_LINK', status: 400 },
  'invalid-url': { message: 'linkImport.INVALID_URL', status: 400 },
  'unsupported-scheme': {
    message: 'linkImport.UNSUPPORTED_SCHEME',
    status: 400,
  },
  'credentials-in-url': {
    message: 'linkImport.CREDENTIALS_IN_URL',
    status: 400,
  },
  'port-not-allowed': { message: 'linkImport.PORT_NOT_ALLOWED', status: 400 },
  'blocked-address': { message: 'linkImport.BLOCKED_ADDRESS', status: 400 },
  // The rule of fetches that name their hosts (the weather's API); a link
  // import names none, so it never meets it.
  'host-not-allowed': { message: 'linkImport.BLOCKED_ADDRESS', status: 400 },
  unresolvable: { message: 'linkImport.UNRESOLVABLE', status: 400 },
  'too-many-redirects': {
    message: 'linkImport.TOO_MANY_REDIRECTS',
    status: 502,
  },
  // The rule of fetches that pass `mayFollow` (the order mail's poll); a
  // link import passes none, so it never meets it.
  'redirect-not-followed': {
    message: 'linkImport.TOO_MANY_REDIRECTS',
    status: 502,
  },
  'http-status': { message: 'linkImport.HTTP_STATUS', status: 502 },
  'blocked-by-site': { message: 'linkImport.BLOCKED_BY_SITE', status: 502 },
  'unexpected-content-type': {
    message: 'linkImport.UNEXPECTED_CONTENT_TYPE',
    status: 502,
  },
  'too-large': { message: 'linkImport.TOO_LARGE', status: 502 },
  timeout: { message: 'linkImport.TIMEOUT', status: 502 },
  network: { message: 'linkImport.NETWORK', status: 502 },
  'unreadable-image': { message: 'linkImport.UNREADABLE_IMAGE', status: 502 },
};

export interface LinkImportDeps {
  db: Db;
  fetcher: OutboundFetcher;
  photos: Photos;
  logger: Logger;
}

/**
 * LINK_IMPORT_LIMIT's one checker, built in webPlugin and handed to every
 * route that fetches a user's link: the page's import and photo choice,
 * and the API's import share one budget per user.
 */
export interface LinkImportLimit {
  linkImportLimit: RateLimitChecker;
}

/** One of a page's photos, to pick instead of the first. */
export interface PhotoChoice {
  /** The image's address, fetched again when it is picked. */
  url: string;
  /** A small WebP as a data: URL (the CSP allows no other origin's images). */
  preview: string;
}

export type LinkImport =
  | { kind: 'image'; photo: string }
  | {
      kind: 'page';
      product: ExtractedProduct;
      /** The pending photo: the first candidate that could be read. */
      photo: string | undefined;
      /** Every candidate that could be read, when there are two or more. */
      choices: PhotoChoice[];
    };

/**
 * What `url` gives the garment form, the pending photo stored for `userId`
 * (the user fetching; the save gives the `file` row to the wardrobe's
 * owner). Throws
 * LinkImportError for a link the fetcher refused or an image that cannot
 * be read.
 */
export async function importLink(
  deps: LinkImportDeps,
  url: string,
  userId: number,
): Promise<LinkImport> {
  const resource = await fetchOrRefuse(deps, url, ['html', 'image']);
  if (resource.kind === 'image') {
    return { kind: 'image', photo: await storePhoto(deps, resource, userId) };
  }
  const product = extractProduct(
    pageText(resource),
    resource.url,
    URL.parse(url) ?? resource.url,
  );
  // A title-only read (an app shell, or a redirect to the shop's home page)
  // has no photo of the garment: its og:image is the shop's logo.
  const { choices, first } = await previewChoices(
    deps,
    product.confidence === 'title-only'
      ? []
      : product.images.slice(0, MAX_PHOTO_CHOICES),
  );
  const photo = first ? await storePhoto(deps, first, userId) : undefined;
  deps.logger.info(
    `Link import from ${resource.url.hostname}: ${product.source ?? 'nothing'} extracted (${product.confidence})${resource.truncated ? ' from the page cut at the cap' : ''}, ${choices.length} of ${product.images.length} photos read${photo ? `, ${photo} pending` : ''}`,
  );
  return {
    kind: 'page',
    product,
    photo,
    choices: choices.length > 1 ? choices : [],
  };
}

/**
 * The product page at `url`, read as importLink reads one (fetched through
 * the outbound fetcher, extractProduct), with where it ended after
 * redirects; nothing fetched past the page, nothing stored. The order
 * mail's poll (#25, ../order-mail/poll.ts) reads each link of an order
 * email so, passing `mayFollow` (#698: its product-link rule, every
 * redirect); "Add to closet" then runs importLink on the one it keeps.
 * Throws OutboundFetchError (logged by the fetcher) for a refusal.
 */
export async function readProductPage(
  fetcher: OutboundFetcher,
  url: string,
  mayFollow?: FetchRequest['mayFollow'],
): Promise<{ product: ExtractedProduct; url: URL }> {
  const resource = await fetcher.fetch(url, { accept: ['html'], mayFollow });
  return {
    product: extractProduct(pageText(resource), resource.url),
    url: resource.url,
  };
}

/**
 * The photo at `url` (a choice the form offered, or any image link) stored
 * as a pending photo for `userId`; its stored name.
 */
export async function fetchLinkPhoto(
  deps: LinkImportDeps,
  url: string,
  userId: number,
): Promise<string> {
  return storePhoto(deps, await fetchOrRefuse(deps, url, ['image']), userId);
}

async function fetchOrRefuse(
  { fetcher }: LinkImportDeps,
  url: string,
  accept: readonly ('html' | 'image')[],
): Promise<FetchedResource> {
  try {
    return await fetcher.fetch(url, { accept });
  } catch (error) {
    // The fetcher logged the refusal with its hosts.
    if (error instanceof OutboundFetchError) {
      throw new LinkImportError(error.reason);
    }
    throw error;
  }
}

/**
 * Stores the image as `userId`'s pending photo (keepPendingPhoto: the row,
 * the per-user cap).
 */
async function storePhoto(
  deps: LinkImportDeps,
  resource: FetchedResource,
  userId: number,
): Promise<string> {
  let fileName: string;
  try {
    ({ fileName } = await deps.photos.storeImage(
      imageSource(resource),
      userId,
    ));
  } catch (error) {
    // Photos' refusals of the bytes themselves (unreadable, too many pixels).
    if (error instanceof HttpError && error.statusCode < 500) {
      throw new LinkImportError('unreadable-image');
    }
    throw error;
  }
  await keepPendingPhoto(deps, fileName, userId);
  return fileName;
}

export type ChoiceDeps = Pick<LinkImportDeps, 'fetcher' | 'logger'> & {
  photos: Pick<Photos, 'inputPixels' | 'preview'>;
};

/**
 * The candidates that are images Photos can read, in the page's order,
 * with their previews, and the first of them as fetched (to store as the
 * pending photo). One that is refused, unreadable or past the pixel budget
 * is left out (the fetcher logs its refusals, Photos an unreadable image;
 * a skip for the budget is logged here), never failing the import.
 *
 * Bounded however many candidates there are: CHOICE_CONCURRENCY at a time,
 * each one's pixels (read from its header, before any is decoded) taken
 * from CHOICE_PIXEL_BUDGET, and only the first readable one's bytes kept
 * past its preview. The budget goes in the order headers are read: the
 * page's, unless an earlier photo is slower to fetch.
 */
export async function previewChoices(
  { fetcher, photos, logger }: ChoiceDeps,
  urls: readonly string[],
): Promise<{ choices: PhotoChoice[]; first: FetchedResource | undefined }> {
  const previews: (PhotoChoice | undefined)[] = [];
  let first: { index: number; resource: FetchedResource } | undefined;
  let budget = CHOICE_PIXEL_BUDGET;

  const previewOne = async (url: string, index: number): Promise<void> => {
    let resource: FetchedResource;
    try {
      resource = await fetcher.fetch(url, { accept: ['image'] });
      const pixels = await photos.inputPixels(imageSource(resource));
      if (pixels > budget) {
        logger.warn(
          `Link import skipped photo ${index + 1} from ${resource.url.hostname}: ${pixels} pixels, ${budget} left of the import's budget`,
        );
        return;
      }
      budget -= pixels;
      const webp = await photos.preview(imageSource(resource));
      previews[index] = {
        url,
        preview: `data:image/webp;base64,${webp.toString('base64')}`,
      };
    } catch (error) {
      if (
        error instanceof OutboundFetchError ||
        (error instanceof HttpError && error.statusCode < 500)
      ) {
        return;
      }
      throw error;
    }
    if (!first || index < first.index) first = { index, resource };
  };

  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const index = next++;
      await previewOne(urls[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CHOICE_CONCURRENCY, urls.length) }, worker),
  );
  return {
    choices: previews.filter((choice) => choice !== undefined),
    first: first?.resource,
  };
}

function imageSource(resource: FetchedResource): ImageSource {
  return {
    stream: Readable.from([resource.body]),
    mimetype: resource.mediaType,
    // For Photos' log lines: the host only, never the path (a product link
    // can carry a token).
    filename: `a photo from ${resource.url.hostname}`,
    // A stranger's bytes are never decoded as HEIC (#699): the fetcher
    // refuses its types, and this keeps a name or a type from reaching it.
    fetched: true,
  };
}

/**
 * The page as text: UTF-8, unless its content type names another charset
 * that TextDecoder knows (an unknown label falls back to UTF-8).
 */
function pageText({ body, charset }: FetchedResource): string {
  if (charset && charset !== 'utf-8' && charset !== 'utf8') {
    try {
      return new TextDecoder(charset).decode(body);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
  return body.toString('utf8');
}
