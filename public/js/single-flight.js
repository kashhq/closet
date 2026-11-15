/**
 * Runs an async task one at a time, without dropping a call that arrives
 * mid-flight: such a call gets one more run after the current one settles
 * (every call in that window shares it). A plain "join the run in flight"
 * answers newer evidence with a result taken before it existed, which is how
 * an `offline` event during the page-load heartbeat was lost for 30 s (#436).
 *
 * Used by connectivity.js's probe; unit-tested in
 * src/web/layout/single-flight.spec.ts.
 *
 * @template {unknown[]} A
 * @template T
 * @param {(...args: A) => Promise<T>} task
 * @returns {(...args: A) => Promise<T>}
 */
export function singleFlight(task) {
  let current = null;
  let next = null;
  const start = (args) => {
    current = task(...args).finally(() => {
      current = null;
    });
    return current;
  };
  return (...args) => {
    if (!current) return start(args);
    // `current` is the promise after start()'s finally, so it is null by
    // the time rerun runs; a rejected run still gets its follow-up.
    const rerun = () => {
      next = null;
      return start(args);
    };
    next ??= current.then(rerun, rerun);
    return next;
  };
}

/**
 * The newest call wins: every call runs `fetchAnswer` at once, aborting the
 * one in flight through its signal, and only the newest call's answer is
 * handed to `apply`. An older answer that arrives late, or an older call's
 * rejection (its abort included), is dropped, so the network's order never
 * decides what is applied. Resolves whether this call's answer was applied.
 *
 * Used by freshness.js's server copy after a sync (#900); unit-tested in
 * src/web/layout/single-flight.spec.ts.
 *
 * @template {unknown[]} A
 * @template T
 * @param {(signal: AbortSignal, ...args: A) => Promise<T>} fetchAnswer
 * @param {(answer: T, ...args: A) => void} apply
 * @returns {(...args: A) => Promise<boolean>}
 */
export function latestOnly(fetchAnswer, apply) {
  let sequence = 0;
  let inFlight = null;
  return async (...args) => {
    sequence += 1;
    const mine = sequence;
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    try {
      const answer = await fetchAnswer(controller.signal, ...args);
      if (mine !== sequence) return false;
      apply(answer, ...args);
      return true;
    } catch (error) {
      if (mine !== sequence) return false;
      throw error;
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  };
}
