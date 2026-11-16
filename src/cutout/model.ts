import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Logger } from '../logger';

/**
 * The server cutout model: which file, where it comes from, how to feed it.
 * Not baked into the image (940 MB): downloaded into MODELS_PATH on first
 * need (at boot, or `npm run cutout:fetch-model`), to a
 * temporary name, checksum-verified, then renamed into place. A file whose
 * checksum does not match is refused, never loaded.
 */
export interface ModelSpec {
  /** For the logs. */
  name: string;
  /** Under MODELS_PATH. A different model (or revision) needs a new name. */
  fileName: string;
  /** Pinned to a repository revision, so the bytes behind it cannot change. */
  url: string;
  sha256: string;
  bytes: number;
  /** The square input the model takes, in pixels per side. */
  inputSize: number;
  /** Per-channel (RGB) normalisation of 0-1 pixel values. */
  mean: readonly [number, number, number];
  std: readonly [number, number, number];
}

/**
 * BiRefNet 512x512 (MIT), chosen by the 2026-09-26 benchmark
 * (docs/audits/2026-09-25-program2/bg-removal-benchmark.md): 5/5 correct
 * garment cutouts, ~3.3 s a photo on 4 threads, ~3.4 GB peak RSS. ImageNet
 * normalisation and a sigmoid on the output, as its preprocessor_config.json
 * and the benchmark's pipeline.
 */
export const BIREFNET_512: ModelSpec = {
  name: 'BiRefNet 512x512',
  fileName: 'birefnet_512.onnx',
  url: 'https://huggingface.co/onnx-community/BiRefNet_512x512-ONNX/resolve/b0b30aff33d009f6bcd7dacdc3cdcf2f8f42175b/onnx/model.onnx',
  sha256: '617a11ca04cb13a2817bfad605969b4a9a040fceedbaaa46348a3957f0f6c254',
  bytes: 940_413_603,
  inputSize: 512,
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
};

/** The file under MODELS_PATH is not the pinned model. */
export class ModelChecksumError extends Error {
  constructor(path: string, expected: string, actual: string) {
    super(
      `${path} is not the expected model (sha256 ${actual}, expected ${expected}). Delete it, or run npm run cutout:fetch-model to replace it.`,
    );
    this.name = 'ModelChecksumError';
  }
}

/**
 * The model's host refused the download or could not be reached (an HTTP
 * error, DNS, a reset before the first byte or a body that broke off
 * partway). The queue's waiting state
 * names it as kind `download` (queue-state.ts).
 */
export class ModelDownloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModelDownloadError';
  }
}

export type Fetch = typeof fetch;

/**
 * The model file of one process: verified once, then trusted for the
 * process's life. Concurrent callers share one attempt; a failed attempt
 * (network down, checksum refused) is retried by the next call.
 */
export class CutoutModel {
  readonly path: string;
  private verified: Promise<string> | undefined;

  constructor(
    readonly spec: ModelSpec,
    private readonly directory: string,
    private readonly logger: Logger,
    private readonly fetchImpl: Fetch = fetch,
  ) {
    this.path = join(directory, spec.fileName);
  }

  /**
   * The verified model's path, downloading it first when it is missing.
   * `replaceMismatched` (the fetch CLI, an operator's explicit request)
   * downloads over a file that fails the checksum instead of refusing it.
   */
  ready({ replaceMismatched = false } = {}): Promise<string> {
    this.verified ??= this.verify(replaceMismatched).catch((error) => {
      this.verified = undefined;
      throw error;
    });
    return this.verified;
  }

  private async verify(replaceMismatched: boolean): Promise<string> {
    const existing = await stat(this.path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!existing) {
      await this.download();
      return this.path;
    }
    const startedAt = Date.now();
    const actual = await sha256Of(createReadStream(this.path));
    if (actual === this.spec.sha256) {
      this.logger.info(
        `${this.spec.name} verified at ${this.path} in ${Date.now() - startedAt}ms`,
      );
      return this.path;
    }
    const mismatch = new ModelChecksumError(
      this.path,
      this.spec.sha256,
      actual,
    );
    if (!replaceMismatched) {
      this.logger.error(mismatch.message);
      throw mismatch;
    }
    this.logger.warn(`${mismatch.message} Replacing it.`);
    await this.download();
    return this.path;
  }

  // To a temporary name in the same directory (so the rename is atomic),
  // hashed on the way; renamed only when size and checksum match.
  private async download(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temp = join(
      this.directory,
      `.${this.spec.fileName}.${randomUUID()}.partial`,
    );
    const startedAt = Date.now();
    this.logger.info(
      `Downloading ${this.spec.name} (${megabytes(this.spec.bytes)} MB) to ${this.path}`,
    );
    try {
      const host = new URL(this.spec.url).host;
      const response = await this.fetchImpl(this.spec.url).catch(
        (error: unknown) => {
          throw new ModelDownloadError(
            `Model download failed: ${host} could not be reached`,
            { cause: error },
          );
        },
      );
      if (!response.ok || !response.body) {
        throw new ModelDownloadError(
          `Model download failed: HTTP ${response.status} from ${host}`,
        );
      }
      const hash = createHash('sha256');
      let bytes = 0;
      await pipeline(
        transferFrom(
          Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
          host,
        ),
        new Transform({
          transform(chunk: Buffer, _encoding, done) {
            hash.update(chunk);
            bytes += chunk.length;
            done(null, chunk);
          },
        }),
        createWriteStream(temp),
      );
      const actual = hash.digest('hex');
      if (bytes !== this.spec.bytes || actual !== this.spec.sha256) {
        throw new ModelChecksumError(
          `The download (${bytes} bytes)`,
          this.spec.sha256,
          actual,
        );
      }
      await rename(temp, this.path);
    } catch (error) {
      await rm(temp, { force: true });
      this.logger.error(
        { err: error },
        `Downloading ${this.spec.name} failed after ${seconds(startedAt)} s`,
      );
      throw error;
    }
    this.logger.info(
      `Downloaded and verified ${this.spec.name} in ${seconds(startedAt)} s`,
    );
  }
}

// The response body's chunks, a read failure (a reset or a stalled host
// minutes into 940 MB) a ModelDownloadError like one before the first byte
// (#870), so the queue waits with the `download` kind and its fix. Only the
// body's: a failed write of the temp file keeps its own code (EACCES is
// `permission`, ENOSPC `other`).
async function* transferFrom(
  body: Readable,
  host: string,
): AsyncGenerator<Buffer> {
  try {
    for await (const chunk of body) yield chunk as Buffer;
  } catch (error) {
    throw new ModelDownloadError(
      `Model download failed: the transfer from ${host} broke off`,
      { cause: error },
    );
  }
}

async function sha256Of(stream: Readable): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const megabytes = (bytes: number) => Math.round(bytes / 1e6);
const seconds = (since: number) => ((Date.now() - since) / 1000).toFixed(1);
