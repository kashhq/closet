import { createHash } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureLogs } from '../../test/support/log-capture';
import {
  CutoutModel,
  type Fetch,
  ModelChecksumError,
  ModelDownloadError,
  type ModelSpec,
} from './model';
import { modelUnavailableKind } from './queue-state';

const MODEL_BYTES = Buffer.from('pretend onnx weights');

const spec: ModelSpec = {
  name: 'Test model',
  fileName: 'test.onnx',
  url: 'https://models.test/rev/test.onnx',
  sha256: createHash('sha256').update(MODEL_BYTES).digest('hex'),
  bytes: MODEL_BYTES.length,
  inputSize: 4,
  mean: [0, 0, 0],
  std: [1, 1, 1],
};

let directory: string;
const { logger, logs } = captureLogs();

const serving = (body: Buffer, status = 200) =>
  vi.fn<Fetch>(() =>
    Promise.resolve(new Response(new Uint8Array(body), { status })),
  );

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'closet-model-'));
  logs.clear();
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('CutoutModel.ready', () => {
  it('downloads a missing model, verifies it, and trusts it afterwards', async () => {
    const fetchImpl = serving(MODEL_BYTES);
    const model = new CutoutModel(spec, directory, logger, fetchImpl);

    await expect(model.ready()).resolves.toBe(join(directory, 'test.onnx'));
    await expect(model.ready()).resolves.toBe(model.path);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(spec.url);
    expect((await readFile(model.path)).equals(MODEL_BYTES)).toBe(true);
    expect(await readdir(directory)).toEqual(['test.onnx']);
    expect(logs.messages('info')).toEqual([
      expect.stringMatching(/^Downloading Test model \(0 MB\) to /),
      expect.stringMatching(/^Downloaded and verified Test model in [\d.]+ s$/),
    ]);
  });

  it('refuses a download with the wrong checksum, keeps nothing, and tries again next time', async () => {
    const fetchImpl = serving(Buffer.from('tampered weights!!!!'));
    const model = new CutoutModel(spec, directory, logger, fetchImpl);

    await expect(model.ready()).rejects.toBeInstanceOf(ModelChecksumError);
    expect(await readdir(directory)).toEqual([]);

    await expect(model.ready()).rejects.toBeInstanceOf(ModelChecksumError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails on an HTTP error without leaving a partial file', async () => {
    const model = new CutoutModel(
      spec,
      directory,
      logger,
      serving(Buffer.from('not found'), 404),
    );
    await expect(model.ready()).rejects.toThrow(
      'Model download failed: HTTP 404 from models.test',
    );
    expect(await readdir(directory)).toEqual([]);
  });

  // #870: a body that broke off partway was a bare stream error, so the
  // queue waited as `other` with the generic fix.
  it('fails a body that breaks off as a download failure, keeping nothing', async () => {
    const brokenOff = vi.fn<Fetch>(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(MODEL_BYTES.subarray(0, 4)));
              controller.error(new TypeError('terminated'));
            },
          }),
        ),
      ),
    );
    const model = new CutoutModel(spec, directory, logger, brokenOff);

    const failure = await model.ready().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelDownloadError);
    expect((failure as Error).message).toBe(
      'Model download failed: the transfer from models.test broke off',
    );
    expect(modelUnavailableKind(failure)).toBe('download');
    expect(await readdir(directory)).toEqual([]);
  });

  // Root writes through mode bits: the read-only case means nothing there.
  it.skipIf(process.getuid?.() === 0)(
    'keeps a failed write of the download its own code, not a download failure',
    async () => {
      await chmod(directory, 0o555);
      try {
        const model = new CutoutModel(
          spec,
          directory,
          logger,
          serving(MODEL_BYTES),
        );
        const failure = await model.ready().catch((error: unknown) => error);
        expect(failure).not.toBeInstanceOf(ModelDownloadError);
        expect(modelUnavailableKind(failure)).toBe('permission');
      } finally {
        await chmod(directory, 0o755);
      }
    },
  );

  it('verifies a model already on disk without downloading', async () => {
    await writeFile(join(directory, 'test.onnx'), MODEL_BYTES);
    const fetchImpl = serving(MODEL_BYTES);
    const model = new CutoutModel(spec, directory, logger, fetchImpl);

    await expect(model.ready()).resolves.toBe(model.path);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a mismatched file on disk and leaves it for the operator', async () => {
    const stranger = Buffer.from('some other model');
    await writeFile(join(directory, 'test.onnx'), stranger);
    const fetchImpl = serving(MODEL_BYTES);
    const model = new CutoutModel(spec, directory, logger, fetchImpl);

    await expect(model.ready()).rejects.toThrow(/npm run cutout:fetch-model/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await readFile(model.path)).equals(stranger)).toBe(true);
  });

  it('replaces a mismatched file when asked to (the fetch CLI)', async () => {
    await writeFile(join(directory, 'test.onnx'), Buffer.from('stale'));
    const model = new CutoutModel(
      spec,
      directory,
      logger,
      serving(MODEL_BYTES),
    );

    await expect(model.ready({ replaceMismatched: true })).resolves.toBe(
      model.path,
    );
    expect((await readFile(model.path)).equals(MODEL_BYTES)).toBe(true);
  });
});
