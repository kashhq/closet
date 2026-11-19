import { describe, expect, it } from 'vitest';
// connectivity.ts's probe runs in the browser; its scheduling is this pure
// helper, tested here.
import {
  latestOnly,
  singleFlight,
} from '../../../views/assets/page/single-flight';

/** A task whose runs settle when the test says, recording each run's argument. */
function controlled() {
  const runs: string[] = [];
  const settle: Array<(ok: boolean) => void> = [];
  const task = (arg: string) => {
    runs.push(arg);
    return new Promise<string>((resolve, reject) => {
      settle.push((ok) => (ok ? resolve(arg) : reject(new Error(arg))));
    });
  };
  return { runs, settle, task };
}

describe('singleFlight', () => {
  // The #436 regression: joining the run in flight answered an `offline`
  // event with the page-load probe's 200.
  it('answers calls made mid-flight with one fresh run, not the stale one', async () => {
    const { runs, settle, task } = controlled();
    const run = singleFlight(task);
    const first = run('load');
    const second = run('offline-event');
    const third = run('htmx:sendError');
    expect(second).toBe(third);
    expect(runs).toEqual(['load']);

    settle[0](true);
    await expect(first).resolves.toBe('load');
    expect(runs).toEqual(['load', 'offline-event']);
    settle[1](true);
    await expect(second).resolves.toBe('offline-event');

    // Idle again: the next call starts at once, with no follow-up.
    const fourth = run('timer');
    expect(runs).toEqual(['load', 'offline-event', 'timer']);
    settle[2](true);
    await expect(fourth).resolves.toBe('timer');
    expect(runs).toHaveLength(3);
  });

  it('still runs the follow-up when the run in flight rejects', async () => {
    const { runs, settle, task } = controlled();
    const run = singleFlight(task);
    const first = run('a');
    const second = run('b');
    settle[0](false);
    await expect(first).rejects.toThrow('a');
    expect(runs).toEqual(['a', 'b']);
    settle[1](true);
    await expect(second).resolves.toBe('b');
  });
});

/** A fetch per call whose answer the test releases, in any order. */
function deferredFetches() {
  const calls: Array<{
    signal: AbortSignal;
    answer: (value: string) => void;
    fail: (error: Error) => void;
  }> = [];
  const fetchAnswer = (signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      calls.push({ signal, answer: resolve, fail: reject });
    });
  return { calls, fetchAnswer };
}

// freshness.js's server copy after a sync (#900): each outbox:synced starts
// a fetch; only the newest one's page may be taken.
describe('latestOnly', () => {
  it('drops an older answer that arrives after a newer one', async () => {
    const { calls, fetchAnswer } = deferredFetches();
    const applied: string[] = [];
    const take = latestOnly(fetchAnswer, (page: string) => applied.push(page));
    const first = take();
    const second = take();
    calls[1].answer('newer');
    calls[0].answer('older');
    await expect(second).resolves.toBe(true);
    await expect(first).resolves.toBe(false);
    expect(applied).toEqual(['newer']);
  });

  it('drops an older answer that arrives first, and applies the newer one alone', async () => {
    const { calls, fetchAnswer } = deferredFetches();
    const applied: string[] = [];
    const take = latestOnly(fetchAnswer, (page: string) => applied.push(page));
    const first = take();
    const second = take();
    calls[0].answer('older');
    await expect(first).resolves.toBe(false);
    expect(applied).toEqual([]);
    calls[1].answer('newer');
    await expect(second).resolves.toBe(true);
    expect(applied).toEqual(['newer']);
  });

  it('aborts the call it supersedes and swallows its rejection, but not the newest one’s', async () => {
    const { calls, fetchAnswer } = deferredFetches();
    const take = latestOnly(fetchAnswer, () => undefined);
    const first = take();
    const second = take();
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls[1].signal.aborted).toBe(false);
    calls[0].fail(new Error('aborted'));
    await expect(first).resolves.toBe(false);
    calls[1].fail(new Error('offline'));
    await expect(second).rejects.toThrow('offline');
  });

  it('runs a call after the last one settled as a fresh one', async () => {
    const { calls, fetchAnswer } = deferredFetches();
    const applied: string[] = [];
    const take = latestOnly(fetchAnswer, (page: string) => applied.push(page));
    const first = take();
    calls[0].answer('one');
    await first;
    const second = take();
    expect(calls[0].signal.aborted).toBe(false);
    calls[1].answer('two');
    await second;
    expect(applied).toEqual(['one', 'two']);
  });
});
