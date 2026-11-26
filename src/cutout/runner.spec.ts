import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { captureLogs } from '../../test/support/log-capture';
import { PROJECT_ROOT } from '../project-root';
import type { ModelSpec } from './model';
import { CutoutTimeoutError, ModelBindingError, ModelRunner } from './runner';

/**
 * The model process's lifecycle, against stand-in processes that speak the
 * protocol (test/fixtures/cutout-children/): the real model is exercised by
 * test/integration/cutout-model.spec.ts when its file is present.
 */

const fixture = (name: string) =>
  join(PROJECT_ROOT, 'test', 'fixtures', 'cutout-children', `${name}.mjs`);

const spec = {
  name: 'Fake model',
  inputSize: 2,
  mean: [0, 0, 0],
  std: [1, 1, 1],
} as unknown as ModelSpec;

const model = { spec, ready: () => Promise.resolve('/models/fake.onnx') };
const rgb = Buffer.alloc(2 * 2 * 3, 128);

const { logger, logs } = captureLogs();
let runner: ModelRunner | undefined;

function build(
  child: string,
  options: { timeoutMs?: number; idleMs?: number } = {},
) {
  logs.clear();
  runner = new ModelRunner({
    model,
    threads: 2,
    logger,
    childPath: fixture(child),
    ...options,
  });
  return runner;
}

const started = () =>
  logs.messages('info').filter((message) => / started /.test(message));

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) {
    await sleep(10);
  }
  expect(condition()).toBe(true);
};

afterEach(async () => {
  await runner?.close();
  runner = undefined;
});

describe('ModelRunner', () => {
  it('returns the mask and the process memory, keeping one process loaded', async () => {
    const runner = build('echo');

    const first = await runner.mask(rgb);
    await runner.mask(rgb);

    expect([...first.mask]).toEqual([200, 200, 200, 200]);
    expect(first).toMatchObject({ inferenceMs: 5, rssMb: 11, maxRssMb: 12 });
    expect(started()).toEqual([
      expect.stringMatching(
        /^Model process \d+ started \(Fake model, 2 threads\)$/,
      ),
    ]);
    expect(logs.messages('info')).toContainEqual(
      expect.stringMatching(/loaded the model in 1 ms \(RSS 10 MB\)$/),
    );
  });

  it('kills a process past the timeout and starts a fresh one for the next image', async () => {
    const runner = build('hang', { timeoutMs: 100 });

    await expect(runner.mask(rgb)).rejects.toBeInstanceOf(CutoutTimeoutError);
    await until(() =>
      logs
        .messages('info')
        .some((message) => /exited \(timed out\)$/.test(message)),
    );
    await expect(runner.mask(rgb)).rejects.toBeInstanceOf(CutoutTimeoutError);
    expect(started()).toHaveLength(2);
  });

  it('fails the image when the process dies under it', async () => {
    const runner = build('crash');
    await expect(runner.mask(rgb)).rejects.toThrow(
      'Model process exited (code 137)',
    );
    expect(logs.messages('warn')).toContainEqual(
      expect.stringMatching(/exited unexpectedly \(code 137\)$/),
    );
  });

  it('fails the image and drops the process when the model cannot load', async () => {
    const runner = build('bad-model');
    await expect(runner.mask(rgb)).rejects.toThrow('Model: invalid model file');
    await until(() =>
      logs
        .messages('info')
        .some((message) => /exited \(model load failed\)$/.test(message)),
    );
  });

  it('unloads the model after the idle time and reloads on the next image', async () => {
    const runner = build('echo', { idleMs: 50 });
    await runner.mask(rgb);
    await until(() =>
      logs
        .messages('info')
        .some((message) => /exited \(idle for/.test(message)),
    );
    await runner.mask(rgb);
    expect(started()).toHaveLength(2);
  });

  // #689: the arm64 image has no onnxruntime binding; ready() must say so
  // before the queue claims a photo, without loading the model.
  it('is ready once a model process answers the binding probe, and probes once', async () => {
    const runner = build('echo');
    await runner.ready();
    await runner.ready();
    const probed = logs
      .messages('info')
      .filter((message) => /loaded onnxruntime-node in \d+ ms$/.test(message));
    expect(probed).toHaveLength(1);
    // The probe loads no model: the first image starts its own process.
    expect(started()).toEqual([]);
  });

  it('refuses ready() with a ModelBindingError when the process dies before answering', async () => {
    const runner = build('no-binding');
    const refused = runner.ready();
    await expect(refused).rejects.toBeInstanceOf(ModelBindingError);
    await expect(refused).rejects.toThrow(
      'The model process could not load onnxruntime-node (exited with code 1)',
    );
  });

  it('stops the process on close', async () => {
    const runner = build('echo');
    await runner.mask(rgb);
    await runner.close();
    expect(logs.messages('info')).toContainEqual(
      expect.stringMatching(/exited \(shutdown\)$/),
    );
  });
});
