/**
 * Keeps a store into a session cache and the drop of that cache from
 * overlapping (#1019). Deleting a cache and its expiration rows are two
 * writes that cannot be atomic, so no order of them survives a store landing
 * between: the entry or its row would outlive the session it belongs to
 * (#731). Instead a store holds a token from the moment it is admitted until
 * its entry and its expiration row are written, and a drop (`emptying`)
 * starts deleting only once no token is held, while no store is admitted
 * during it. Used by the worker's `sessionStore` plugin and
 * `emptySessionCaches` (views/assets/src-sw.ts).
 */
export class StoreGate {
  private readonly held = new Set<Promise<void>>();
  private emptyingNow: Promise<void> | undefined;

  /**
   * Synchronous, so the caller's generation check and this admission cannot
   * straddle a drop. A release function, or undefined while a drop is
   * emptying (wait on `idle`, then ask again).
   */
  begin(): (() => void) | undefined {
    if (this.emptyingNow) return undefined;
    let release!: () => void;
    const token = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.held.add(token);
    return () => {
      this.held.delete(token);
      release();
    };
  }

  /** Settles when no drop is emptying. */
  idle(): Promise<void> {
    return this.emptyingNow ?? Promise.resolve();
  }

  /**
   * Runs a drop's deletes after every admitted store has finished. The drops
   * are serialized by the caller (the worker's ownership lock).
   */
  emptying<T>(work: () => Promise<T>): Promise<T> {
    const run = (async () => {
      while (this.held.size > 0) await Promise.all([...this.held]);
      return work();
    })();
    const marker = run.then(
      () => undefined,
      () => undefined,
    );
    this.emptyingNow = marker;
    void marker.then(() => {
      if (this.emptyingNow === marker) this.emptyingNow = undefined;
    });
    return run;
  }
}
