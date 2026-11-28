import type { Logger } from '../../logger';

interface Pending {
  /** When the address's BEARER_REFUSAL_LIMIT window ends (epoch ms). */
  windowEndsAt: number;
  count: number;
  kinds: Map<string, number>;
}

/** Addresses held at once; the oldest is summarised and dropped past it. */
const CAPACITY = 1_000;

/**
 * What the bearer gate refused from an address after its refusal budget ran
 * out (BEARER_REFUSAL_LIMIT), or with an expired OAuth access token after the
 * window's first (logsOwnLine), so that a flood costs one log line per
 * address per window instead of one per call (#940; the NAS log freeze was
 * #632).
 * Each answer is unchanged; only the line is deferred and counted.
 *
 * No timers: a summary is written when its window has ended, found by the
 * next refusal of any address (`flushEnded`), or when `CAPACITY` addresses
 * are held and the oldest makes room. Memory is `CAPACITY` small entries. An
 * address that stops while nobody else is refused leaves its summary
 * unwritten until the next refusal or the process ends: the cost of no timer.
 */
export class RefusalSummaries {
  readonly #pending = new Map<string, Pending>();

  constructor(
    private readonly logger: Logger,
    // Not `Date.now` itself: specs that pin the clock replace Date after this exists.
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Counts one refusal answered without its own line; `kind` is the reason's words. */
  suppress(address: string, kind: string, windowMs: number): void {
    const entry = this.#live(address) ?? this.#open(address, windowMs);
    entry.count += 1;
    entry.kinds.set(kind, (entry.kinds.get(kind) ?? 0) + 1);
  }

  /**
   * Whether a refusal no budget charges (an expired OAuth access token,
   * bearer-gate.ts) gets a line of its own: the first from an address with
   * no window open does, and opens one of `windowMs`; the rest in it are
   * counted as `suppress` counts them, so a client stuck on an expired
   * token costs one line and one summary per window, never a line a call.
   */
  logsOwnLine(address: string, kind: string, windowMs: number): boolean {
    if (!this.#live(address)) {
      this.#open(address, windowMs);
      return true;
    }
    this.suppress(address, kind, windowMs);
    return false;
  }

  /** The address's open window; one that has ended is written and dropped. */
  #live(address: string): Pending | undefined {
    const entry = this.#pending.get(address);
    if (entry && entry.windowEndsAt <= this.now()) {
      this.#write(address, entry);
      return undefined;
    }
    return entry;
  }

  #open(address: string, windowMs: number): Pending {
    if (this.#pending.size >= CAPACITY) {
      const [oldest] = this.#pending.keys();
      this.#write(oldest, this.#pending.get(oldest)!);
    }
    const entry: Pending = {
      windowEndsAt: this.now() + windowMs,
      count: 0,
      kinds: new Map(),
    };
    this.#pending.set(address, entry);
    return entry;
  }

  /** Writes the summaries whose window has ended; called on every refusal. */
  flushEnded(): void {
    const now = this.now();
    for (const [address, entry] of this.#pending) {
      // Insertion order is near window order: stop at the first live one.
      if (entry.windowEndsAt > now) return;
      this.#write(address, entry);
    }
  }

  #write(address: string, entry: Pending): void {
    this.#pending.delete(address);
    // A window logsOwnLine opened that nothing followed: its line said it all.
    if (entry.count === 0) return;
    const kinds = [...entry.kinds]
      .map(([kind, count]) => `${kind} x${count}`)
      .join(', ');
    this.logger.warn(
      `${entry.count} further credential refusals from ${address} not logged one by one (${kinds})`,
    );
  }
}
