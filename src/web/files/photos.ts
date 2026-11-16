import type { MultipartFile } from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';
import sharp, { type OutputInfo, type Sharp } from 'sharp';
import type { Config } from '../../config';
import {
  applyCutoutEvent,
  type CutoutOutcome,
  type CutoutRow,
  lockCutoutRow,
} from '../../cutout/queries';
import type { CutoutEvent, CutoutStatus, Transition } from '../../cutout/state';
import type { Db } from '../../db/client';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { NotServed } from '../refusals';
import { errorFields, type Logger } from '../../logger';
import { PROJECT_ROOT } from '../../project-root';
import {
  type DecodedHeic,
  decodeHeic,
  imageTooLarge,
  isHeicUpload,
} from './heic';
import {
  HeicDecoder,
  type HeicDecoderOptions,
  type HeicDecoding,
} from './heic-decoder';
import type { SignablePhotoRef } from './image-url';
import {
  type ImageVariant,
  newVariantKey,
  parseStoredName,
  type StoredPhoto,
  unkeyedPhoto,
  variantFileName,
} from './image-variant';
import {
  findPhotoByShareableId,
  findVariantKey,
  readPhotoRef,
  type NewPhotoRow,
} from './queries';
import { claimStorage } from './storage-identity';
import { type InstallPairing, PhotoStorage } from './storage';

const IMAGE_MAX_PX = 1080;
const IMAGE_QUALITY = 90;
const THUMB_MAX_PX = 400;
const THUMB_QUALITY = 80;
// A cutout's thumb is trimmed to the garment (cutoutThumb, contentBox, #373).
// The visible pixels are those above this alpha: BiRefNet's mask is soft,
// leaving a faint haze (shadows, floor texture, a few percent opaque) that
// is invisible on the plinth but spread over the frame, and would hold the
// box open to its edges. ~9% is above that haze and below any edge worth
// keeping: an antialiased garment edge ramps through it within a pixel.
const CUTOUT_ALPHA_THRESHOLD = 24;
// The room left around the garment on every side, as a share of the box's
// longer side: enough that a tile never cuts a sleeve at its edge.
const CUTOUT_MARGIN = 0.05;
// A box smaller than this share of the frame is not a garment (a model
// that found nothing leaves a speck or two above the threshold); its thumb
// keeps the whole frame, as every thumb did before the trim, rather than
// blowing a speck up to the tile.
const MIN_CONTENT_FRACTION = 0.005;
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
// Link import's photo choices (preview): small enough that six inline as
// data: URLs keep the page light.
const PREVIEW_MAX_PX = 240;
const PREVIEW_QUALITY = 70;
// openCurrentCutout: each retry follows a swap that landed meanwhile; a
// photo swapped this often during one copy is copied without its cutout.
const MAX_CUTOUT_READS = 3;

/**
 * The decompression-bomb guard on every decode (sharp's limitInputPixels,
 * and the HEIC dimension check before its pixels are allocated). sharp's own
 * default is ~268 MP, about a gigabyte of pixels for a file of a few KB.
 * 64 MP admits every phone's full-resolution mode up to 50 MP (Pixel,
 * 8160x6144) and refuses the 200 MP modes; a refused upload is a 400.
 */
export const MAX_INPUT_PIXELS = 64_000_000;

/** A sharp pipeline that decodes at most MAX_INPUT_PIXELS; the only way Photos builds one. */
function decoder(raw?: DecodedHeic['raw']): Sharp {
  return sharp({ limitInputPixels: MAX_INPUT_PIXELS, ...(raw && { raw }) });
}

/** Pixels Photos made itself (a decoded original, a mask), under the same limit. */
function rawImage(
  pixels: Buffer,
  width: number,
  height: number,
  channels: 1 | 3 | 4,
): Sharp {
  return sharp(pixels, {
    limitInputPixels: MAX_INPUT_PIXELS,
    raw: { width, height, channels },
  });
}

/**
 * Image bytes from wherever Photos takes them: an upload's multipart part
 * (storeUpload), the seed's generated art (src/seed/), a fetched product
 * photo (link import, #6).
 */
export interface ImageSource {
  stream: Readable;
  mimetype: string;
  /** As the sender named it: for logs, and the HEIC hint (isHeicUpload). */
  filename: string;
  /**
   * Bytes from the internet (link import): never decoded as HEIC, whatever
   * their type or name (#699), so a stranger's site never reaches the
   * decoder; a HEIC there is an unreadable image. Uploads are HEIC by type
   * or name.
   */
  fetched?: true;
}

export interface StoreImageOptions {
  /**
   * The image's transparency is already its cutout (art drawn on a
   * transparent background, the seed's): the original is stored flattened
   * on white, as a photo of the garment would be, and the cutout is the art
   * as drawn, padded square like every cutout; the thumb derives from it.
   * The caller inserts the row as a finished cutout,
   * initialCutoutState('ready'), rather than queueing it.
   */
  alphaIsCutout?: boolean;
  /**
   * Clockwise degrees to turn the image after its EXIF orientation is
   * applied: rotateStored's copy of a stored original.
   */
  rotate?: QuarterTurn;
}

/** A garment photo's rotation (POST /wardrobe/:id/photo/rotate), clockwise degrees. */
export type QuarterTurn = 90 | 270;

/**
 * The photo after the mask editor's save (saveEditedCutout): its new
 * variant set, the version its URLs carry and the cutout state it is in.
 */
export type EditedCutout = SignablePhotoRef & {
  version: number;
  cutoutStatus: CutoutStatus;
};

/**
 * The source side of a transcode failed (undecodable bytes, truncated
 * upload) as opposed to the storage side. Uploads map it to a 400; a thumb
 * rebuild hitting it means our own stored original is corrupt.
 */
class UnreadableImageError extends Error {
  constructor(readonly cause: unknown) {
    super(`Unreadable image: ${String(cause)}`);
    this.name = 'UnreadableImageError';
  }
}

export interface PhotosConfig {
  /** DATA_PATH: where the photo files live. */
  dataPath: string;
  /** MAX_HEIC_BYTES: HEIC parts are buffered whole, so this bounds memory. */
  maxHeicBytes: number;
  /** Absolute path of the app icon composited onto share previews. */
  watermarkIconPath: string;
  /** WATERMARK_ENABLED: composite the icon; the resize happens regardless. */
  watermarkEnabled: boolean;
  /** Enforced only with APP_ENV production (claimStorage, #833). */
  installPairing: InstallPairing;
}

/** Where photos live and how share previews are made, from config. */
export function photosConfig(config: Config): PhotosConfig {
  return {
    dataPath: config.DATA_PATH,
    maxHeicBytes: config.MAX_HEIC_BYTES,
    watermarkIconPath: join(PROJECT_ROOT, 'public', 'assets', config.ICON_NAME),
    watermarkEnabled: config.WATERMARK_ENABLED,
    installPairing: config.APP_ENV === 'production' ? 'enforced' : 'advisory',
  };
}

/**
 * Builds the one Photos instance of a process (its thumb single-flight map
 * must be shared by every caller) and prepares its directory: creates it,
 * sweeps stale partial writes and claims it (claimStorage: rejects with a
 * StorageIdentityError on an unmounted share). createApp() builds the
 * server's and hands it to the web layer; each CLI builds its own.
 */
export async function createPhotos(
  config: PhotosConfig,
  db: Db,
  logger: Logger,
  heic: HeicDecoderOptions = {},
): Promise<Photos> {
  const storage = new PhotoStorage(config.dataPath, logger);
  storage.prepare();
  await claimStorage(storage, db, logger, config.installPairing);
  logger.info(`Photos stored under ${config.dataPath}`);
  return new Photos(storage, db, logger, config, new HeicDecoder(logger, heic));
}

/**
 * Everything about a photo: variant naming, transcoding, thumbnail
 * derivation, versions, and the bytes on disk (PhotoStorage). Every photo is
 * a set of WebP files sharing one base name; only the original has a `file`
 * row (see image-variant.ts).
 *
 * Bytes are written before any row exists. storeImage and copy return the
 * row to insert (NewPhotoRow) instead of inserting it, so the caller commits
 * it in the same transaction as the garment that references it and calls
 * deleteVariants if that transaction fails: nothing on disk is ever pointed
 * at by a half-written state. Rows are removed by their owners' transactions
 * too; deleteVariants after commit unlinks the bytes (the database cascade
 * never does, AGENTS.md Gotchas).
 */
export class Photos {
  // Pending thumb write per thumb file name. Writes are chained rather than
  // deduplicated so that one started later always lands last; lazy reads
  // join the write already in flight instead of starting a duplicate. A
  // cutout's keyed thumb (writeCutout) is a new name no other write meets.
  private readonly thumbJobs = new Map<string, Promise<void>>();
  private watermark: Promise<Buffer> | undefined;

  constructor(
    readonly storage: PhotoStorage,
    private readonly db: Db,
    private readonly logger: Logger,
    private readonly config: Pick<
      PhotosConfig,
      'maxHeicBytes' | 'watermarkIconPath' | 'watermarkEnabled'
    >,
    private readonly heic: HeicDecoding,
  ) {}

  /** Ends the HEIC decoder's thread (createApp's onClose); nothing else holds a resource. */
  close(): Promise<void> {
    return this.heic.close();
  }

  /** storeImage for a multipart part; a 400 without one. */
  storeUpload(
    upload: MultipartFile | undefined,
    userId: number,
  ): Promise<NewPhotoRow> {
    if (!upload) throw new HttpError(400, t('refusal.request.noFile'));
    return this.storeImage(
      {
        stream: upload.file,
        mimetype: upload.mimetype,
        filename: upload.filename,
      },
      userId,
    );
  }

  /**
   * Transcodes the image to the original variant (1080 px, WebP, the decode
   * bound and HEIC included) and derives its thumb; with `alphaIsCutout`
   * the cutout too. Returns the row to insert; on failure nothing is left in
   * storage. Bytes that are not an image are the sender's error: a 400.
   */
  async storeImage(
    source: ImageSource,
    userId: number,
    options: StoreImageOptions = {},
  ): Promise<NewPhotoRow> {
    const fileName = `${randomUUID()}.webp`;
    const { pixels, raw } = await this.imageSource(source);
    // Every path honours EXIF orientation, the art's included (#199: a
    // sideways cutout upload stayed sideways). HEIC arrives decoded and
    // rotated already, with no EXIF left, so it is a no-op there.
    const oriented = decoder(raw).autoOrient();
    if (options.rotate) oriented.rotate(options.rotate);
    const art = options.alphaIsCutout
      ? await this.decodeUpload(
          pixels,
          oriented
            .resize(IMAGE_MAX_PX, IMAGE_MAX_PX, {
              fit: sharp.fit.inside,
              withoutEnlargement: true,
            })
            .ensureAlpha()
            .raw(),
        )
      : undefined;
    if (!art) {
      await this.transcodeUpload(
        pixels,
        originalTransformer(oriented),
        fileName,
      );
    }
    try {
      if (art) await this.storeArtwork(art, fileName);
      await this.regenerateThumb(unkeyedPhoto(fileName));
    } catch (error) {
      await this.deleteVariants(unkeyedPhoto(fileName));
      throw error;
    }
    this.logger.info(
      `Stored ${source.filename} as ${fileName} for user ${userId}${options.alphaIsCutout ? ' (its own cutout)' : ''}`,
    );
    return newPhotoRow(fileName, userId);
  }

  /**
   * The row to insert for a photo whose bytes are already stored but which
   * has no row yet: a pending photo (a link import's fetch, an add-sheet
   * upload), held until its garment form is saved
   * (createGarmentWithPendingPhoto, src/web/wardrobe/writes.ts).
   * Undefined when `fileName` is not a stored original's name or its bytes
   * are gone (reconciliation removes such photos after a day). Whether a
   * row already exists is the caller's check, under its lock.
   */
  async pendingPhotoRow(
    fileName: string,
    userId: number,
  ): Promise<NewPhotoRow | undefined> {
    if (parseStoredName(fileName)?.variant !== 'original') return undefined;
    if (!(await this.storage.exists(fileName))) return undefined;
    return newPhotoRow(fileName, userId);
  }

  /**
   * A small WebP of an image that is not stored: link import's photo
   * choices, shown inline as data: URLs before one is picked. The CSP
   * allows no other origin's images, and the choices must not be stored:
   * every unpicked one would be an orphan counting against reconciliation's
   * deletion guard. The same decode bound and HEIC path as a stored photo;
   * unreadable bytes are a 400 HttpError.
   */
  async preview(source: ImageSource): Promise<Buffer> {
    const { pixels, raw } = await this.imageSource(source);
    return this.encodeUpload(
      pixels,
      decoder(raw)
        .autoOrient()
        .resize(PREVIEW_MAX_PX, PREVIEW_MAX_PX, {
          fit: sharp.fit.inside,
          withoutEnlargement: true,
        })
        .webp({ quality: PREVIEW_QUALITY }),
    );
  }

  /**
   * How many pixels decoding the image would take, read from its header
   * without decoding any: for a caller that budgets several decodes (link
   * import's choices, fetched: never a HEIC, which sharp cannot read). The
   * same refusals as a decode: 400 for bytes that are not an image, 400
   * "Image too large" past MAX_INPUT_PIXELS. Consumes the stream.
   */
  async inputPixels(source: ImageSource): Promise<number> {
    let pixels: number;
    try {
      pixels = await this.headerPixels(source);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      this.logger.warn(
        { err: error },
        `Rejected unreadable image ${source.filename}`,
      );
      throw decodeRefusal(error);
    }
    if (pixels > MAX_INPUT_PIXELS) throw imageTooLarge();
    return pixels;
  }

  /**
   * The garment photo form's multipart body: its `photo` part, stored as
   * storeUpload does; undefined when no photo was sent. Every other part is
   * drained unread, notably `nobgPhoto`: pages an installed PWA cached
   * before background removal moved to the server still post the browser's
   * cutout, and the server makes its own.
   *
   * The photo's pipeline is started inside the `for await` loop and awaited
   * only after it: @fastify/multipart yields live streams, and a part nobody
   * reads backpressures the parser. It is armed with a no-op catch where it
   * starts (startPipeline): a rejection while later parts are still being
   * read would otherwise be an unhandled rejection that kills the process.
   * The real error still surfaces from the caller's await.
   *
   * A body refused after the photo's pipeline started (its file cut at the
   * route's `fileSize`, which the parser reports only once the stream has
   * ended, so a JPEG whose image data came first still decodes; a file past
   * `files`) throws from the loop with the pipeline still running: it is
   * awaited and its bytes deleted before the refusal goes on, or they would
   * be stored with no row (an orphan for reconciliation).
   */
  async storeUploadParts(
    parts: AsyncIterable<MultipartFile>,
    userId: number,
  ): Promise<NewPhotoRow | undefined> {
    let photo: Promise<NewPhotoRow> | undefined;
    try {
      for await (const part of parts) {
        if (part.fieldname === 'photo' && !photo) {
          photo = startPipeline(this.storeUpload(part, userId));
          continue;
        }
        if (part.fieldname === 'nobgPhoto') {
          this.logger.info(
            `Upload by user ${userId}: ignored the browser's cutout (a page cached before server-side removal)`,
          );
        }
        part.file.resume();
      }
    } catch (error) {
      await this.discardStartedUpload(photo, userId);
      throw error;
    }
    return photo;
  }

  // The pipeline's own failure already left nothing (storeImage); only a
  // stored photo is deleted here. Never throws: the caller rethrows the
  // refusal (a 413 stays a 413), and bytes a failed delete leaves are
  // reconciliation's orphan.
  private async discardStartedUpload(
    photo: Promise<NewPhotoRow> | undefined,
    userId: number,
  ): Promise<void> {
    const stored = await photo?.catch(() => undefined);
    if (!stored) return;
    try {
      await this.deleteVariants(unkeyedPhoto(stored.fileName));
    } catch (error) {
      this.logger.error(
        { err: error },
        `Upload by user ${userId} refused after its photo was stored: could not delete ${stored.fileName}`,
      );
      return;
    }
    this.logger.info(
      `Upload by user ${userId} refused after its photo was stored: deleted ${stored.fileName}`,
    );
  }

  /**
   * Byte-for-byte copy of the original and, when present, the cutout the
   * source's row points at, under a fresh name (unkeyed: the copy has no
   * row yet), with a new thumb; returns the row to insert, as storeUpload
   * does. Undefined when the source is gone from storage (a row can outlive
   * its bytes). `source` is the photo as the caller read its row (the
   * clone's garment): its variant key is the cutout's first guess, read
   * again only when a swap moved it meanwhile.
   */
  async copy(
    source: StoredPhoto,
    userId: number,
  ): Promise<NewPhotoRow | undefined> {
    const sourceFileName = source.fileName;
    const original = await this.storage.get(sourceFileName);
    if (!original) {
      this.logger.warn(`Photo copy: source ${sourceFileName} is missing`);
      return undefined;
    }

    const copied = unkeyedPhoto(`${randomUUID()}.webp`);
    try {
      await this.storage.store(copied.fileName, original);
      const nobgSource = await this.openCurrentCutout(
        sourceFileName,
        source.variantKey,
      );
      if (nobgSource) {
        await this.storage.store(
          variantFileName(copied.fileName, 'nobg'),
          nobgSource,
        );
      }
      await this.regenerateThumb(copied);
    } catch (error) {
      await this.deleteVariants(copied);
      throw error;
    }
    this.logger.info(`Copied photo ${sourceFileName} to ${copied.fileName}`);
    return newPhotoRow(copied.fileName, userId);
  }

  /**
   * A stored photo turned by `turn` as a new photo (the rotate button,
   * rotateGarmentPhoto): the original's bytes through storeImage, so the
   * source's files are never touched, and with `withCutout` the cutout
   * the source's row points at, turned the same way (a mask edit
   * survives: the cutout is a padded square, so turning it is what cutting
   * out the turned original gives). Returns the row to insert, as
   * storeImage does, and whether the cutout came along: false when the
   * source had none on disk (then it needs a new one). A 404 when the
   * original is gone.
   */
  async rotateStored(
    sourceFileName: string,
    turn: QuarterTurn,
    userId: number,
    withCutout: boolean,
  ): Promise<{ row: NewPhotoRow; cutoutKept: boolean }> {
    const row = await this.storeImage(
      {
        stream: await this.getOrNotFound(sourceFileName),
        mimetype: 'image/webp',
        filename: sourceFileName,
      },
      userId,
      { rotate: turn },
    );
    if (!withCutout) return { row, cutoutKept: false };

    const rotated = unkeyedPhoto(row.fileName);
    try {
      const cutout = await this.openCurrentCutout(sourceFileName);
      if (!cutout) {
        this.logger.warn(
          `Rotating ${sourceFileName}: its cutout is missing; ${row.fileName} will need a new one`,
        );
        return { row, cutoutKept: false };
      }
      await this.transcode(
        cutout,
        decoder().rotate(turn).webp({ quality: IMAGE_QUALITY }),
        variantFileName(row.fileName, 'nobg'),
      );
      // storeImage made the thumb from the original; a cutout's comes from it.
      await this.regenerateThumb(rotated);
    } catch (error) {
      await this.deleteVariants(rotated);
      throw error;
    }
    this.logger.info(
      `Rotated ${sourceFileName} by ${turn}° as ${row.fileName}, its cutout with it`,
    );
    return { row, cutoutKept: true };
  }

  // The cutout the row points at, opened (an open file streams whole even
  // when it is deleted after); undefined when the photo has none. A swap
  // between reading the key and opening its file deletes the set it
  // replaced, so a missing file under a key the row no longer names is
  // read again under the new one: a copy (a clone keeps the source's
  // ready or edited status) must not lose the cutout to that race. A
  // caller that read the row already passes its key (`known`), sparing
  // the first read.
  private async openCurrentCutout(
    fileName: string,
    known?: string | null,
  ): Promise<Readable | undefined> {
    let key =
      known === undefined
        ? ((await findVariantKey(this.db, fileName)) ?? null)
        : known;
    for (let attempt = 1; ; attempt++) {
      const opened = await this.storage.get(
        variantFileName(fileName, 'nobg', key),
      );
      if (opened || attempt === MAX_CUTOUT_READS) return opened;
      const current = (await findVariantKey(this.db, fileName)) ?? null;
      if (current === key) return undefined;
      this.logger.info(
        `Cutout of ${fileName} swapped from ${key ?? 'unkeyed'} to ${current ?? 'unkeyed'} while it was read; reading again`,
      );
      key = current;
    }
  }

  /**
   * The mask editor's cutout replaces the stored one (the `edit` event: a
   * user's mask always wins, and no server job result replaces it after).
   * Returns the photo as its URLs now name it (the new version and variant
   * key: the editor's next image and edit read those); undefined when no
   * row has that name. The upload is encoded and stored before the row is
   * locked, so neither a slow client nor slow storage ever holds the lock.
   */
  async saveEditedCutout(
    stream: Readable,
    originalFileName: string,
  ): Promise<EditedCutout | undefined> {
    const bytes = await this.encodeUpload(
      stream,
      originalTransformer(decoder()),
    );
    const outcome = await this.writeCutout(
      originalFileName,
      (variantKey) => ({ type: 'edit', variantKey }),
      await cutoutFiles(bytes),
    );
    if (!outcome.ok) {
      this.logger.warn(
        `Edited cutout for ${originalFileName} not stored: ${outcome.reason}`,
      );
      return undefined;
    }
    const { version, variantKey, status } = outcome.state;
    // A garment's photo: the mask editor edits only those (never a selfie,
    // `unwanted`, which the machine refuses an edit).
    return readPhotoRef({
      fileName: originalFileName,
      version,
      variantKey,
      cutoutStatus: status,
    });
  }

  /**
   * The server model's input for a stored photo: the original as stored
   * (1080 px, already decoded, HEIC included) stretched to `size` x `size`
   * RGB, 3 bytes a pixel. Stretched rather than padded, as the model's own
   * preprocessing and the benchmark did; saveModelCutout stretches the mask
   * back. A 404 HttpError when the original is gone.
   */
  async cutoutInput(fileName: string, size: number): Promise<Buffer> {
    const source = await this.getOrNotFound(fileName);
    const transformer = decoder()
      .removeAlpha()
      .resize(size, size, { fit: 'fill', kernel: 'lanczos3' })
      .raw();
    source.on('error', (error) => transformer.destroy(error));
    return source.pipe(transformer).toBuffer();
  }

  /**
   * A server job's result (the queue, src/cutout/queue.ts): `mask`, a
   * `maskSize` square of 0-255 alpha from the model, becomes the photo's
   * cutout, stored only while the state machine accepts `succeed` for the
   * photo version the job started for (never over an edit or a replaced
   * photo). The outcome says which.
   */
  async saveModelCutout(
    fileName: string,
    mask: Buffer,
    maskSize: number,
    jobVersion: number,
  ): Promise<CutoutOutcome> {
    const bytes = await this.composeCutout(fileName, mask, maskSize);
    return this.writeCutout(
      fileName,
      (variantKey) => ({ type: 'succeed', jobVersion, variantKey }),
      await cutoutFiles(bytes),
    );
  }

  /**
   * The retrim-thumbs backfill's step for one photo (#373,
   * src/maintenance/retrim-thumbs.ts): the thumb the photo's cutout derives
   * today (cutoutThumb), stored with a byte-for-byte copy of that cutout
   * under a new variant key the row then points at (the `rederive` event).
   * Never in place: thumbs are served immutable and the app caches them,
   * so only a new URL replaces an old thumb on a phone. `current` when the
   * stored thumb already is that thumb (an idempotent second run), `due`
   * for one a dry run would replace; a dry run stores nothing.
   */
  async rederiveCutoutThumb(
    photo: StoredPhoto,
    { dryRun }: { dryRun: boolean },
  ): Promise<ThumbRederivation> {
    const { fileName, variantKey } = photo;
    const nobg = await this.storage.get(
      variantFileName(fileName, 'nobg', variantKey),
    );
    if (!nobg) {
      // A swap since the caller read the key deleted that set: the photo's
      // new cutout came with its own (trimmed) thumb, so nothing is
      // missing; the machine would refuse it as stale too.
      const current = (await findVariantKey(this.db, fileName)) ?? null;
      return current === variantKey
        ? { result: 'no-cutout' }
        : { result: 'refused', reason: 'stale' };
    }
    const files = await cutoutFiles(await buffer(nobg));
    const stored = await this.storage.get(
      variantFileName(fileName, 'thumb', variantKey),
    );
    // sharp's encoder is deterministic for one libvips: equal bytes are the
    // same thumb.
    if (stored && (await buffer(stored)).equals(files.thumb)) {
      return { result: 'current' };
    }
    if (dryRun) return { result: 'due' };
    const outcome = await this.writeCutout(
      fileName,
      (key) => ({ type: 'rederive', fromKey: variantKey, variantKey: key }),
      files,
    );
    return outcome.ok
      ? { result: 'rederived', version: outcome.state.version }
      : { result: 'refused', reason: outcome.reason };
  }

  // The original's pixels with the mask, stretched back to their size, as
  // alpha, centred on a transparent square (squareCutout).
  private async composeCutout(
    fileName: string,
    mask: Buffer,
    maskSize: number,
  ): Promise<Buffer> {
    const source = await this.getOrNotFound(fileName);
    const decode = decoder().removeAlpha().raw();
    source.on('error', (error) => decode.destroy(error));
    const { data: rgb, info } = await source
      .pipe(decode)
      .toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    const alpha = await rawImage(mask, maskSize, maskSize, 1)
      .resize(width, height, { fit: 'fill' })
      // Without it sharp emits a single-channel input as 3-channel sRGB.
      .extractChannel(0)
      .raw()
      .toBuffer();
    // Joined, then read back, before extend(): sharp orders a pipeline's
    // operations itself, and a channel join must not run after the padding.
    const rgba = await rawImage(rgb, width, height, 3)
      .joinChannel(alpha, { raw: { width, height, channels: 1 } })
      .raw()
      .toBuffer();
    return squareCutout(rgba, width, height);
  }

  // storeImage's alphaIsCutout: the original is the art on white (the share
  // preview is a JPEG of the original and the mask editor paints it back,
  // so neither may meet transparency), the cutout is the art's own alpha,
  // padded as composeCutout pads the model's.
  private async storeArtwork(
    { data, info }: { data: Buffer; info: OutputInfo },
    fileName: string,
  ): Promise<void> {
    const original = await rawImage(data, info.width, info.height, 4)
      .flatten({ background: '#ffffff' })
      .webp({ quality: IMAGE_QUALITY })
      .toBuffer();
    await this.storage.store(fileName, Readable.from(original));
    await this.storage.store(
      variantFileName(fileName, 'nobg'),
      Readable.from(await squareCutout(data, info.width, info.height)),
    );
  }

  /**
   * Stores cutout bytes for an existing photo and points its row at them,
   * only if the state machine accepts the event (src/cutout/state.ts).
   * Every writer of an existing photo's cutout (the mask editor, the server
   * job, the thumb backfill) comes through here.
   *
   * The nobg and its thumb are written first, under a fresh variant key and
   * outside any transaction; the transaction only locks the row, asks the
   * machine and swaps `variant_key` with the version (#141). Storage I/O
   * under the row lock ran into the server pool's idle-in-transaction limit
   * on a slow NFS mount, and a file renamed over the served name before a
   * COMMIT that then failed left new bytes live under the old row. Until
   * the swap commits nothing points at the new files, so a reader sees the
   * old set or the new one whole, and the thumb a new version names exists
   * before the version does. A refused event (a late job result over a
   * user's mask, a replaced photo) or a rolled-back swap leaves its files
   * unreferenced, and they are deleted here; so is the set a swap replaced,
   * after its commit.
   */
  private async writeCutout(
    originalFileName: string,
    eventFor: (variantKey: string) => CutoutEvent,
    files: CutoutFiles,
  ): Promise<CutoutOutcome> {
    const variantKey = newVariantKey();
    const written: StoredPhoto = { fileName: originalFileName, variantKey };
    const event = eventFor(variantKey);
    await this.storeCutoutFiles(written, files);

    // What the transaction decided: settleFailedSwap needs it when the
    // COMMIT landed but its answer was lost.
    let decided: Swap | undefined;
    let swap: Swap | 'gone';
    try {
      swap = await this.db.transaction(async (tx) => {
        const before = await lockCutoutRow(tx, originalFileName);
        if (!before) return 'gone' as const;
        decided = {
          before,
          outcome: await applyCutoutEvent(tx, before, event),
        };
        return decided;
      });
    } catch (error) {
      return this.settleFailedSwap(written, event, decided, error);
    }

    if (swap === 'gone') {
      await this.deleteCutoutFiles(written, 'its photo row is gone');
      return { ok: false, reason: 'gone' };
    }
    const { before, outcome } = swap;
    if (!outcome.ok) {
      await this.deleteCutoutFiles(
        written,
        `${event.type} refused (${outcome.reason})`,
      );
      return outcome;
    }
    this.logger.info(
      `Cutout of ${originalFileName} stored (${event.type}) under key ${variantKey}: ${before.status} -> ${outcome.state.status}, version ${outcome.state.version}`,
    );
    await this.deleteReplacedCutout(before, variantKey);
    return outcome;
  }

  // After a committed swap: the set it replaced (the row's key before it).
  private deleteReplacedCutout(
    before: CutoutRow,
    newKey: string | null,
  ): Promise<void> {
    return this.deleteCutoutFiles(
      { fileName: before.fileName, variantKey: before.variantKey },
      `replaced by key ${newKey}`,
    );
  }

  // The nobg and its thumb under `written`'s key; neither is left behind
  // if either fails.
  private async storeCutoutFiles(
    written: StoredPhoto,
    { nobg, thumb }: CutoutFiles,
  ): Promise<void> {
    const { fileName, variantKey } = written;
    try {
      await this.storage.store(
        variantFileName(fileName, 'nobg', variantKey),
        Readable.from(nobg),
      );
      await this.storage.store(
        variantFileName(fileName, 'thumb', variantKey),
        Readable.from(thumb),
      );
    } catch (error) {
      // Rethrown: the route's error handler or the cutout job logs it.
      await this.deleteCutoutFiles(written, 'storing them failed');
      throw error;
    }
  }

  // The swap's transaction threw: a lock or statement timeout, the
  // idle-in-transaction limit, a dropped connection. Usually it rolled back
  // and the new files are orphans. But when the failure was COMMIT's lost
  // answer the swap may have landed, so the row is asked before its files
  // go, and a swap that landed is the outcome after all. When the row
  // cannot be read either, the files stay (an unreferenced keyed file is
  // reconciliation's, a day later) rather than risk a row pointing at
  // nothing.
  private async settleFailedSwap(
    written: StoredPhoto,
    event: CutoutEvent,
    decided: Swap | undefined,
    error: unknown,
  ): Promise<CutoutOutcome> {
    const { fileName, variantKey } = written;
    let current: string | null | undefined;
    try {
      current = await findVariantKey(this.db, fileName);
    } catch (lookupError) {
      this.logger.error(
        { err: error, lookup_err: errorFields(lookupError) },
        `Cutout of ${fileName} (${event.type}): the swap to key ${variantKey} failed and the row cannot be read; its files are left to reconciliation`,
      );
      throw error;
    }
    // Structured: a driver error's reason is often only in its `cause`
    // (drizzle's "Failed query: commit").
    // Keys are unique per write: the row naming this one means this swap
    // committed and none has moved it since, so the set it replaced is
    // still this write's to delete, as on the normal path.
    if (current === variantKey && decided?.outcome.ok) {
      this.logger.warn(
        { err: error },
        `Cutout of ${fileName} (${event.type}): the swap to key ${variantKey} committed although its transaction failed; version ${decided.outcome.state.version}`,
      );
      await this.deleteReplacedCutout(decided.before, variantKey);
      return decided.outcome;
    }
    // current !== variantKey. Even if this swap had committed after all, a
    // second swap that has moved the key since already deleted this set as
    // the one it replaced, so deleting it again is expected: deleteFiles
    // takes a missing file as done.
    this.logger.warn(
      { err: error },
      `Cutout of ${fileName} (${event.type}): the swap to key ${variantKey} rolled back`,
    );
    await this.deleteCutoutFiles(written, 'its swap rolled back');
    throw error;
  }

  // A nobg and thumb that nothing points at (any more). Never throws: a
  // file left behind is reconciliation's (a superseded variant, a day on).
  private async deleteCutoutFiles(
    set: StoredPhoto,
    why: string,
  ): Promise<void> {
    const names = [
      variantFileName(set.fileName, 'nobg', set.variantKey),
      variantFileName(set.fileName, 'thumb', set.variantKey),
    ];
    await this.deleteFiles(names);
    this.logger.info(`Deleted ${names.join(' and ')}: ${why}`);
  }

  /**
   * Streams a variant of the set the photo's row points at, falling back
   * gracefully: a missing cutout serves the original, a missing thumb is
   * generated on first request (backfill for photos stored before thumbs
   * existed). A 404 HttpError only when the original itself is gone.
   */
  async getVariant(
    photo: StoredPhoto,
    variant: ImageVariant,
  ): Promise<Readable> {
    const { fileName, variantKey } = photo;
    switch (variant) {
      case 'original':
        return this.getOrNotFound(fileName);
      case 'nobg':
        return (
          (await this.storage.get(
            variantFileName(fileName, 'nobg', variantKey),
          )) ?? this.getOrNotFound(fileName)
        );
      case 'thumb': {
        const thumbName = variantFileName(fileName, 'thumb', variantKey);
        const existing = await this.storage.get(thumbName);
        if (existing) return existing;
        await (this.thumbJobs.get(thumbName) ?? this.regenerateThumb(photo));
        return this.getOrNotFound(thumbName);
      }
    }
  }

  /**
   * The variant's file of exactly this set, as stored; undefined when it is
   * not on disk. No fallback and no thumb made: the /file routes' signed
   * path (a URL naming this set), which answers a miss through the row and
   * getVariant. Making a thumb here could write one under a key a swap has
   * since retired, from the original, beside no cutout.
   */
  openStoredVariant(
    photo: StoredPhoto,
    variant: ImageVariant,
  ): Promise<Readable | undefined> {
    return this.storage.get(
      variantFileName(photo.fileName, variant, photo.variantKey),
    );
  }

  /**
   * Rewrites the set's thumb from its cutout if present (trimmed to the
   * garment: cutoutThumb), else from the original (whole).
   */
  regenerateThumb(photo: StoredPhoto): Promise<void> {
    const thumbName = variantFileName(
      photo.fileName,
      'thumb',
      photo.variantKey,
    );
    const previous = this.thumbJobs.get(thumbName) ?? Promise.resolve();
    const job = previous
      .catch(() => undefined)
      .then(() => this.writeThumb(photo, thumbName))
      .finally(() => {
        if (this.thumbJobs.get(thumbName) === job) {
          this.thumbJobs.delete(thumbName);
        }
      });
    this.thumbJobs.set(thumbName, job);
    return job;
  }

  /**
   * Removes every file of the photo: the original, the nobg and thumb its
   * row points at, and the unkeyed ones (a thumb backfilled for a request
   * that raced a cutout's swap can land beside a keyed set). A failure is
   * logged, never thrown.
   */
  async deleteVariants(photo: StoredPhoto): Promise<void> {
    const { fileName, variantKey } = photo;
    await this.deleteFiles([
      fileName,
      variantFileName(fileName, 'nobg'),
      variantFileName(fileName, 'thumb'),
      ...(variantKey === null
        ? []
        : [
            variantFileName(fileName, 'nobg', variantKey),
            variantFileName(fileName, 'thumb', variantKey),
          ]),
    ]);
    this.logger.info(
      `Deleted variants of ${fileName}${variantKey === null ? '' : ` (key ${variantKey})`}`,
    );
  }

  /**
   * Deletes stored files by name (reconciliation's findings: every file of
   * an orphaned photo, a superseded variant). A missing file is not an
   * error; a failure is logged, never thrown.
   */
  async deleteFiles(names: readonly string[]): Promise<void> {
    for (const name of names) {
      await this.storage
        .delete(name)
        .catch((error: unknown) =>
          this.logger.warn({ err: error }, `Failed to delete ${name}`),
        );
    }
  }

  /**
   * The share-preview image of the photo behind `shareableId`: the original
   * as a JPEG within 1080px, with the app icon composited when
   * WATERMARK_ENABLED. `shareableId` is a shared garment's or outfit's
   * (findPhotoByShareableId); NotServed when nothing shared has it.
   */
  async watermarked(shareableId: string): Promise<Readable> {
    const fileName = await findPhotoByShareableId(this.db, shareableId);
    if (!fileName) throw new NotServed();
    const transformer = decoder()
      .jpeg()
      .resize(IMAGE_MAX_PX, IMAGE_MAX_PX, { fit: sharp.fit.inside });
    if (this.config.watermarkEnabled) {
      transformer.composite([
        { input: await this.watermarkIcon(), gravity: 'southwest' },
      ]);
    }
    const source = await this.getOrNotFound(fileName);
    // pipe() does not forward a source failure; the reply streams the
    // transformer, so it must fail with it.
    source.on('error', (error) => transformer.destroy(error));
    return source.pipe(transformer);
  }

  // Built once: the icon does not change while the process runs.
  private watermarkIcon(): Promise<Buffer> {
    this.watermark ??= sharp(this.config.watermarkIconPath, {
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .resize(150, 150)
      .extend({
        top: 0,
        bottom: 20,
        left: 20,
        right: 0,
        background: TRANSPARENT,
      })
      .composite([
        {
          input: Buffer.from([0, 0, 0, 200]),
          raw: { width: 1, height: 1, channels: 4 },
          tile: true,
          blend: 'dest-in',
        },
      ])
      .toBuffer();
    return this.watermark;
  }

  // Bytes missing from storage: what the image server answers for a name
  // it has no file of, whoever asked (rotateStored's caller reads it as a
  // concurrent swap, wardrobe/writes.ts).
  private async getOrNotFound(fileName: string): Promise<Readable> {
    const stream = await this.storage.get(fileName);
    if (!stream) {
      throw new NotServed({ logDetail: `${fileName} is not in storage` });
    }
    return stream;
  }

  // The source's bytes in a form sharp reads: the encoded stream itself, or
  // a HEIC's decoded pixels with their layout.
  private async imageSource(
    source: ImageSource,
  ): Promise<{ pixels: Readable; raw?: DecodedHeic['raw'] }> {
    if (!source.fetched && isHeicUpload(source)) {
      return this.decodeHeicSource(source);
    }
    refuseNonImage(source);
    return { pixels: source.stream };
  }

  // sharp's metadata: the header only, which limitInputPixels does not
  // check (inputPixels does). Every pixel count but a HEIC's.
  private async headerPixels(source: ImageSource): Promise<number> {
    refuseNonImage(source);
    const transformer = decoder();
    source.stream.on('error', (error) => transformer.destroy(error));
    const { width, height } = await source.stream.pipe(transformer).metadata();
    if (!width || !height) throw new Error('No dimensions in the header');
    return width * height;
  }

  // HEIC is the one format sharp cannot read (see heic.ts). The whole part is
  // buffered, so MAX_HEIC_BYTES bounds memory per upload; the 413 from the cap
  // passes through, as do the 400 for too many pixels and the decoder's 503
  // when it has no room; undecodable bytes, a decode past its deadline and a
  // crashed thread are the bad-photo answer like any other.
  private async decodeHeicSource(source: ImageSource): Promise<DecodedHeic> {
    const startedAt = Date.now();
    try {
      const decoded = await decodeHeic(
        source.stream,
        this.config.maxHeicBytes,
        MAX_INPUT_PIXELS,
        this.heic,
      );
      this.logger.debug(
        `Decoded HEIC ${source.filename} (${decoded.raw.width}x${decoded.raw.height}) in ${Date.now() - startedAt}ms`,
      );
      return decoded;
    } catch (error) {
      if (error instanceof HttpError) {
        this.logger.warn(
          { err: error },
          `Rejected HEIC upload ${source.filename}`,
        );
        throw error;
      }
      this.logger.warn(
        { err: error },
        `Rejected undecodable HEIC upload ${source.filename}`,
      );
      throw unreadableImage();
    }
  }

  // Client bytes: an undecodable stream is the client's error, not ours.
  private async transcodeUpload(
    source: Readable,
    transformer: Sharp,
    targetFileName: string,
  ): Promise<void> {
    try {
      await this.transcode(source, transformer, targetFileName);
    } catch (error) {
      if (error instanceof UnreadableImageError) {
        this.logger.warn(
          { err: error },
          `Rejected unreadable upload for ${targetFileName}`,
        );
        throw decodeRefusal(error.cause);
      }
      throw error;
    }
  }

  // Client bytes into memory rather than storage: an undecodable stream is
  // the client's error (400), as in transcodeUpload.
  private async encodeUpload(
    source: Readable,
    transformer: Sharp,
  ): Promise<Buffer> {
    return (await this.decodeUpload(source, transformer)).data;
  }

  // encodeUpload with the output's layout (raw pixels need it).
  private async decodeUpload(
    source: Readable,
    transformer: Sharp,
  ): Promise<{ data: Buffer; info: OutputInfo }> {
    // pipe() does not forward a source failure; toBuffer() must see it.
    source.on('error', (error) => transformer.destroy(error));
    try {
      return await source
        .pipe(transformer)
        .toBuffer({ resolveWithObject: true });
    } catch (error) {
      this.logger.warn({ err: error }, 'Rejected unreadable upload');
      throw decodeRefusal(error);
    }
  }

  private async writeThumb(
    { fileName, variantKey }: StoredPhoto,
    thumbName: string,
  ): Promise<void> {
    const startedAt = Date.now();
    const cutout = await this.storage.get(
      variantFileName(fileName, 'nobg', variantKey),
    );
    if (cutout) {
      const thumb = await cutoutThumb(await buffer(cutout));
      await this.storage.store(thumbName, Readable.from(thumb));
    } else {
      await this.transcode(
        await this.getOrNotFound(fileName),
        thumbOf(decoder()),
        thumbName,
      );
    }
    this.logger.debug(`Wrote ${thumbName} in ${Date.now() - startedAt}ms`);
  }

  // Runs the source through sharp into storage. Both sides are awaited
  // together: pipeline() ending the PassThrough is what tells the store that
  // the body is complete. Whichever side fails first is the root cause; the
  // other then fails from the destroyed PassThrough and is only drained. A
  // source-side failure is reported as UnreadableImageError so callers can
  // tell bad input from storage trouble.
  private async transcode(
    source: Readable,
    transformer: Sharp,
    targetFileName: string,
  ): Promise<void> {
    const passThrough = new PassThrough();
    const stored = this.storage.store(targetFileName, passThrough);
    const piped = pipeline(source, transformer, passThrough).catch(
      (error: unknown) => {
        throw new UnreadableImageError(error);
      },
    );
    try {
      await Promise.all([stored, piped]);
    } catch (error) {
      passThrough.destroy();
      await Promise.allSettled([stored, piped]);
      throw error;
    }
  }
}

/** writeCutout's transaction: the row as it was locked, and what the machine answered. */
interface Swap {
  before: CutoutRow;
  outcome: Transition;
}

/** A cutout set's two files, encoded and ready to store (writeCutout). */
interface CutoutFiles {
  nobg: Buffer;
  thumb: Buffer;
}

/** What rederiveCutoutThumb did for one photo (the retrim-thumbs backfill). */
export type ThumbRederivation =
  /** The row's nobg is not in storage: nothing to derive from. */
  | { result: 'no-cutout' }
  /** The stored thumb already is the one the cutout derives. */
  | { result: 'current' }
  /** A dry run: the thumb would be replaced. */
  | { result: 'due' }
  /** Stored under a new key; the row is at `version`. */
  | { result: 'rederived'; version: number }
  /**
   * The machine refused the swap, or the key read is no longer the row's
   * (an edit landed meanwhile, the row is gone); nothing kept.
   */
  | { result: 'refused'; reason: 'not-allowed' | 'stale' | 'gone' };

/** A cutout's set: its bytes and the thumb they derive (one rule for every writer). */
async function cutoutFiles(nobg: Buffer): Promise<CutoutFiles> {
  return { nobg, thumb: await cutoutThumb(nobg) };
}

// The stored original's size and encoding (storeImage), and an edited
// cutout's (saveEditedCutout), over a decoder().
function originalTransformer(decoded: Sharp): Sharp {
  return decoded
    .resize(IMAGE_MAX_PX, IMAGE_MAX_PX, {
      fit: sharp.fit.inside,
      withoutEnlargement: true,
    })
    .webp({ quality: IMAGE_QUALITY });
}

// The thumb of the whole image: an original's (writeThumb without a
// cutout), and a cutout's when contentBox finds no garment in it.
function thumbOf(decoded: Sharp): Sharp {
  return decoded
    .resize(THUMB_MAX_PX, THUMB_MAX_PX, {
      fit: sharp.fit.inside,
      withoutEnlargement: true,
    })
    .webp({ quality: THUMB_QUALITY });
}

/**
 * A cutout's thumb, trimmed to the garment (#373): its contentBox, centred
 * on a transparent square, at THUMB_MAX_PX, so every garment fills its tile
 * whatever the photo's framing. Every thumb made from a cutout comes
 * through here (writeThumb, cutoutFiles), so none differs by its path. Only
 * the thumb is trimmed: the stored cutout keeps the original's frame,
 * which the mask editor relies on (it pads the original the same way to
 * paint it back; public/js/mask-editor.js). The trimmed square is resized
 * to exactly THUMB_MAX_PX, enlarging a small garment on purpose: a tile
 * draws it at that size anyway, and every tile then carries the same
 * resolution.
 */
async function cutoutThumb(cutout: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(cutout, {
    limitInputPixels: MAX_INPUT_PIXELS,
  })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const box = contentBox(data, width, height);
  if (!box) return thumbOf(rawImage(data, width, height, 4)).toBuffer();
  const { side, padding } = squarePadding(box.width, box.height);
  // Cropped and padded, then read back before the resize: within one
  // pipeline sharp resizes before it extends.
  const square = await rawImage(data, width, height, 4)
    .extract(box)
    .extend(padding)
    .raw()
    .toBuffer();
  return rawImage(square, side, side, 4)
    .resize(THUMB_MAX_PX, THUMB_MAX_PX)
    .webp({ quality: THUMB_QUALITY })
    .toBuffer();
}

/** A rectangle of an image's pixels, as sharp's extract() takes it. */
interface PixelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a cutout's garment is in its frame: the bounding box of the pixels
 * whose alpha is above CUTOUT_ALPHA_THRESHOLD, grown by CUTOUT_MARGIN of
 * its longer side on every side and clamped to the frame. Undefined when
 * nothing is visible or the box is under MIN_CONTENT_FRACTION of the
 * frame: the thumb then keeps the whole frame. `rgba` is 4 bytes a pixel,
 * row by row.
 */
function contentBox(
  rgba: Buffer,
  width: number,
  height: number,
): PixelBox | undefined {
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (rgba[row + x * 4 + 3] <= CUTOUT_ALPHA_THRESHOLD) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = y;
    }
  }
  const boxWidth = right - left + 1;
  const boxHeight = bottom - top + 1;
  if (
    right < 0 ||
    boxWidth * boxHeight < MIN_CONTENT_FRACTION * width * height
  ) {
    return undefined;
  }
  const margin = Math.round(CUTOUT_MARGIN * Math.max(boxWidth, boxHeight));
  const x0 = Math.max(0, left - margin);
  const y0 = Math.max(0, top - margin);
  return {
    left: x0,
    top: y0,
    width: Math.min(width, right + 1 + margin) - x0,
    height: Math.min(height, bottom + 1 + margin) - y0,
  };
}

// Bytes Photos cannot read as any image: a 400.
function refuseNonImage(source: ImageSource): void {
  if (source.mimetype?.startsWith('image/')) return;
  // https://github.com/fastify/fastify-multipart/issues/497
  // An unconsumed multipart stream hangs the request: drain, then refuse.
  source.stream.resume();
  throw new HttpError(400, t('refusal.upload.wrongType'));
}

// sharp reports limitInputPixels only through its message ("Input image
// exceeds pixel limit"); the header is read before any pixel, so this is
// the refusal, not a failed decode.
function exceedsPixelLimit(cause: unknown): boolean {
  return cause instanceof Error && /exceeds pixel limit/i.test(cause.message);
}

/** Bytes sharp or the HEIC decoder could not read: the client's error, a 400. */
function unreadableImage(): HttpError {
  return new HttpError(400, t('refusal.upload.unreadable'));
}

/** A failed decode's 400: over sharp's pixel limit, else unreadable. */
function decodeRefusal(cause: unknown): HttpError {
  return exceedsPixelLimit(cause) ? imageTooLarge() : unreadableImage();
}

/**
 * Arms a pipeline started inside a multipart `for await` loop: a rejection
 * while the loop still reads later parts is then never unhandled (which
 * would exit the process). The same promise is returned, so the error still
 * reaches whoever awaits it (replacePhoto, from storeUploadParts). Node's default of crashing
 * on an unhandled rejection is kept on purpose: no process-level handler.
 */
function startPipeline<T>(pipeline: Promise<T>): Promise<T> {
  pipeline.catch(() => undefined);
  return pipeline;
}

/**
 * A cutout's pixels (RGBA) centred on a transparent square: the shape the
 * browser's model gave every older cutout, which the mask editor (it pads
 * the original the same way to paint it back) and the square tiles rely on.
 */
function squareCutout(
  rgba: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  return rawImage(rgba, width, height, 4)
    .extend(squarePadding(width, height).padding)
    .webp({ quality: IMAGE_QUALITY })
    .toBuffer();
}

// The transparent extend() centring a width x height image on a square
// (the odd pixel goes right and below): the stored cutout's and the
// trimmed thumb's; the mask editor's squarePadBlob pads the same way.
function squarePadding(width: number, height: number) {
  const side = Math.max(width, height);
  const left = Math.floor((side - width) / 2);
  const top = Math.floor((side - height) / 2);
  return {
    side,
    padding: {
      left,
      right: side - width - left,
      top,
      bottom: side - height - top,
      background: TRANSPARENT,
    },
  };
}

function newPhotoRow(fileName: string, userId: number): NewPhotoRow {
  return {
    fileName,
    shareableId: randomUUID(),
    createdOn: new Date().toISOString(),
    createdById: userId,
  };
}
