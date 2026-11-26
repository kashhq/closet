import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Logger } from '../../logger';
import type { HeicReply, HeicRequest } from './heic-worker';

/**
 * Every decode's one deadline, from the moment its bytes are read and it
 * joins the queue: the wait for the thread and the decode together. Past
 * it a waiting decode is dropped and a running one's thread terminated. A
 * 48 MP iPhone photo decodes in a few seconds; this is room for a queue of
 * them, and a ceiling on a container built to never finish.
 */
const HEIC_DEADLINE_MS = 30_000;

/**
 * Decodes queued behind the running one, each holding its container (up to
 * MAX_HEIC_BYTES). With the queue full a decode is refused before its
 * bytes are read, and again if it filled while they were (HeicDecodeError
 * 'busy', the caller's 503). An upload still sending holds no place: four
 * slow bodies cannot shut everyone else out.
 */
const HEIC_MAX_WAITING = 4;

/** An idle thread exits after this: libheif's WASM heap never shrinks. */
const IDLE_MS = 60_000;

/**
 * The thread's JavaScript heap. It does not bound libheif's WASM memory
 * (external to the heap; libheif-js caps its own growth at 2 GB): the pixel
 * check before decode() does, and a WASM abort is a thrown error answered
 * as undecodable.
 */
const HEAP_LIMIT_MB = 256;

/** Why a decode did not answer pixels; heic.ts turns each into its answer. */
export type HeicFailure =
  | Extract<HeicReply, { ok: false }>['reason']
  | 'busy'
  | 'timeout'
  | 'crashed'
  | 'closed';

export class HeicDecodeError extends Error {
  constructor(
    readonly reason: HeicFailure,
    detail: string,
  ) {
    super(`HEIC decode ${reason}: ${detail}`);
    this.name = 'HeicDecodeError';
  }
}

const shuttingDown = () => new HeicDecodeError('closed', 'shutting down');

/** The primary image's RGBA, 4 bytes a pixel. */
export interface HeicPixels {
  width: number;
  height: number;
  pixels: Buffer;
}

export interface HeicDecoderOptions {
  /** The thread's script; the specs substitute a stub (test/support/heic-stub-worker.ts). */
  workerPath?: string;
  deadlineMs?: number;
  maxWaiting?: number;
  idleMs?: number;
}

/** What Photos needs of the decoder; photos.spec.ts substitutes a fake. */
export type HeicDecoding = Pick<HeicDecoder, 'decode' | 'close'>;

interface Job {
  container: Buffer;
  maxPixels: number;
  queuedAt: number;
  startedAt?: number;
  timer: NodeJS.Timeout;
  resolve: (pixels: HeicPixels) => void;
  reject: (error: HeicDecodeError) => void;
}

// dist/web/files/heic-worker.js in the image; the .ts beside this file when
// running from src/ (the tests), which Node 22.18+ runs with its built-in
// type stripping and would warn that the module's type is guessed (as
// src/cutout/runner.ts's child). A Worker takes the flag in its execArgv.
function workerScript(path?: string): { path: string; execArgv: string[] } {
  const built = join(__dirname, 'heic-worker.js');
  const script =
    path ?? (existsSync(built) ? built : join(__dirname, 'heic-worker.ts'));
  return {
    path: script,
    execArgv:
      extname(script) === '.ts'
        ? ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON']
        : [],
  };
}

/**
 * HEIC decoding off the event loop (#699): one worker thread, decoding one
 * container at a time in arrival order. One, not a pool: a decode's cost is
 * memory (a 48 MP photo is ~190 MB of RGBA plus libheif's heap, beside the
 * cutout model's ~3 GB), uploads are paced by people, and PHOTO_UPLOAD_LIMIT
 * caps each user's rate. The thread starts on first use, exits after
 * IDLE_MS idle, and is replaced after a deadline or a crash; it keeps the
 * process alive only while it decodes (a CLI exits without closing it).
 * One per Photos (createPhotos); Photos.close() terminates it.
 */
export class HeicDecoder {
  private readonly script: { path: string; execArgv: string[] };
  private readonly deadlineMs: number;
  private readonly maxWaiting: number;
  private readonly idleMs: number;
  private readonly waiting: Job[] = [];
  private running: Job | undefined;
  private worker: Worker | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    private readonly logger: Logger,
    options: HeicDecoderOptions = {},
  ) {
    this.script = workerScript(options.workerPath);
    this.deadlineMs = options.deadlineMs ?? HEIC_DEADLINE_MS;
    this.maxWaiting = options.maxWaiting ?? HEIC_MAX_WAITING;
    this.idleMs = options.idleMs ?? IDLE_MS;
  }

  /**
   * Decodes the container `read` answers. Refused as 'busy' before `read`
   * is called while HEIC_MAX_WAITING decodes are queued, so a refused
   * upload never holds its bytes, and after it when the queue filled
   * meanwhile; whatever `read` throws (the byte cap's 413) is passed
   * through. Rejects with a HeicDecodeError otherwise.
   */
  async decode(
    read: () => Promise<Buffer>,
    maxPixels: number,
  ): Promise<HeicPixels> {
    this.refuseWithoutRoom();
    const container = await read();
    this.refuseWithoutRoom();
    return new Promise<HeicPixels>((resolve, reject) => {
      const job: Job = {
        container,
        maxPixels,
        queuedAt: performance.now(),
        timer: setTimeout(() => this.expire(job), this.deadlineMs),
        resolve,
        reject,
      };
      this.waiting.push(job);
      this.next();
    });
  }

  /** Terminates the thread; every decode not answered yet is rejected as 'closed'. */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.idleTimer);
    const unanswered = [
      ...(this.running ? [this.running] : []),
      ...this.waiting.splice(0),
    ];
    this.running = undefined;
    for (const job of unanswered) {
      clearTimeout(job.timer);
      job.reject(shuttingDown());
    }
    const worker = this.worker;
    this.worker = undefined;
    if (worker) {
      const id = worker.threadId;
      await worker.terminate();
      this.logger.info(`HEIC decoder thread ${id} stopped`);
    }
  }

  private refuseWithoutRoom(): void {
    if (this.closed) throw shuttingDown();
    if (this.waiting.length >= this.maxWaiting) {
      throw new HeicDecodeError(
        'busy',
        `${this.waiting.length} decodes already waiting`,
      );
    }
  }

  private next(): void {
    if (this.running || this.closed) return;
    const job = this.waiting.shift();
    if (!job) {
      this.idle();
      return;
    }
    this.running = job;
    job.startedAt = performance.now();
    clearTimeout(this.idleTimer);
    const worker = this.worker ?? this.start();
    worker.ref();
    worker.postMessage({
      container: job.container,
      maxPixels: job.maxPixels,
    } satisfies HeicRequest);
  }

  private start(): Worker {
    const worker = new Worker(this.script.path, {
      execArgv: this.script.execArgv,
      resourceLimits: { maxOldGenerationSizeMb: HEAP_LIMIT_MB },
    });
    this.worker = worker;
    // Read now: a thread's id is -1 once it has exited.
    const id = worker.threadId;
    worker.on('message', (reply: HeicReply) => this.answer(worker, reply));
    // Always followed by 'exit', which settles the decode it ran.
    worker.on('error', (error) =>
      this.logger.error({ err: error }, `HEIC decoder thread ${id} failed`),
    );
    worker.on('exit', (code) => this.exited(worker, id, code));
    this.logger.info(`HEIC decoder thread ${id} started`);
    return worker;
  }

  private answer(worker: Worker, reply: HeicReply): void {
    const job = this.running;
    if (worker !== this.worker || !job) return;
    this.running = undefined;
    clearTimeout(job.timer);
    if (reply.ok) {
      job.resolve({
        width: reply.width,
        height: reply.height,
        pixels: Buffer.from(reply.pixels),
      });
    } else {
      job.reject(new HeicDecodeError(reply.reason, reply.message));
    }
    this.next();
  }

  // A thread this decoder still held ended on its own: a crash, the heap
  // limit (ERR_WORKER_OUT_OF_MEMORY). One it let go of (expire, idle,
  // close) is no longer `this.worker`, so its exit is expected.
  private exited(worker: Worker, id: number, code: number): void {
    if (worker !== this.worker) return;
    this.worker = undefined;
    const job = this.running;
    this.running = undefined;
    this.logger.warn(
      `HEIC decoder thread ${id} exited with code ${code}${job ? ' mid-decode' : ''}`,
    );
    if (job) {
      clearTimeout(job.timer);
      job.reject(new HeicDecodeError('crashed', `thread exited (${code})`));
    }
    this.next();
  }

  private expire(job: Job): void {
    const waited = Math.round(performance.now() - job.queuedAt);
    if (job === this.running) {
      this.running = undefined;
      const worker = this.worker!;
      this.worker = undefined;
      this.logger.warn(
        `HEIC decode passed its ${this.deadlineMs} ms deadline after ${Math.round(performance.now() - job.startedAt!)} ms decoding; thread ${worker.threadId} terminated`,
      );
      void worker.terminate();
      job.reject(new HeicDecodeError('timeout', `${waited} ms`));
      this.next();
      return;
    }
    const index = this.waiting.indexOf(job);
    this.waiting.splice(index, 1);
    this.logger.warn(
      `HEIC decode dropped after ${waited} ms waiting for the thread (deadline ${this.deadlineMs} ms)`,
    );
    job.reject(new HeicDecodeError('timeout', `${waited} ms waiting`));
  }

  private idle(): void {
    const worker = this.worker;
    if (!worker) return;
    worker.unref();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.worker !== worker || this.running) return;
      this.worker = undefined;
      this.logger.debug(
        `HEIC decoder thread ${worker.threadId} exiting after ${this.idleMs} ms idle`,
      );
      void worker.terminate();
    }, this.idleMs);
    this.idleTimer.unref();
  }
}
