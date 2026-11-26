import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { captureLogs } from '../../../../test/support/log-capture';
import { HttpError } from '../../errors';
import type { Translated } from '../../i18n';
import { MAX_INPUT_PIXELS } from '../../files/photos';
import {
  type FetchedResource,
  type FetchRequest,
  OutboundFetchError,
} from '../../security/outbound-fetch';
import {
  CHOICE_CONCURRENCY,
  CHOICE_PIXEL_BUDGET,
  type ChoiceDeps,
  previewChoices,
  readProductPage,
} from './import';

/** What a candidate is to the fakes: its pixels, or why it fails. */
type Candidate = number | 'refused' | 'unreadable';

/**
 * previewChoices over a scripted shop: `https://cdn.test/<i>` is candidate
 * i. Fetches and previews take a moment each, so overlapping work shows in
 * the peaks; the header read (inputPixels) is what the budget sees.
 */
function shop(candidates: readonly Candidate[], fetchDelays: number[] = []) {
  const { logger, logs } = captureLogs();
  const peaks = { fetches: 0, previews: 0 };
  let fetching = 0;
  let previewing = 0;
  const previewed: number[] = [];

  const resource = (index: number): FetchedResource => ({
    kind: 'image',
    mediaType: 'image/jpeg',
    charset: null,
    body: Buffer.from(String(index)),
    truncated: false,
    url: new URL(`https://cdn.test/${index}`),
    redirects: 0,
  });
  const indexOfSource = async (stream: Readable) => {
    let text = '';
    for await (const chunk of stream) text += String(chunk);
    return Number(text);
  };

  const deps: ChoiceDeps = {
    logger,
    fetcher: {
      async fetch(url) {
        const index = Number(new URL(url).pathname.slice(1));
        fetching++;
        peaks.fetches = Math.max(peaks.fetches, fetching);
        await delay(fetchDelays[index] ?? 2);
        fetching--;
        if (candidates[index] === 'refused') {
          throw new OutboundFetchError('http-status', 'Refused');
        }
        return resource(index);
      },
    },
    photos: {
      async inputPixels(source) {
        const candidate = candidates[await indexOfSource(source.stream)];
        if (typeof candidate === 'number') return candidate;
        throw new HttpError(400, 'Unreadable image' as Translated);
      },
      async preview(source) {
        const index = await indexOfSource(source.stream);
        previewing++;
        peaks.previews = Math.max(peaks.previews, previewing);
        await delay(2);
        previewing--;
        previewed.push(index);
        return Buffer.from(`preview ${index}`);
      },
    },
  };
  const urls = candidates.map((_, index) => `https://cdn.test/${index}`);
  return { deps, urls, peaks, previewed, logs };
}

describe('previewChoices', () => {
  it('spends one upload of pixels on all the choices together', () => {
    expect(CHOICE_PIXEL_BUDGET).toBe(MAX_INPUT_PIXELS);
  });

  it(`works on at most ${CHOICE_CONCURRENCY} candidates at once, however many there are`, async () => {
    for (const count of [3, 12, 40]) {
      const { deps, urls, peaks } = shop(Array(count).fill(1_000_000));

      const { choices } = await previewChoices(deps, urls);

      expect(choices).toHaveLength(count);
      // A candidate is fetched only once a worker is free, so this many
      // fetched bodies and decodes at most exist at once, whatever the count.
      expect(peaks.fetches).toBe(CHOICE_CONCURRENCY);
      expect(peaks.previews).toBeLessThanOrEqual(CHOICE_CONCURRENCY);
    }
  });

  it('keeps many near-limit candidates within the budget, skipping the rest', async () => {
    const near = MAX_INPUT_PIXELS - 1_000_000;
    const { deps, urls, previewed, logs } = shop(Array(24).fill(near));

    const { choices, first } = await previewChoices(deps, urls);

    // One near-limit photo leaves too little for another.
    expect(previewed).toHaveLength(1);
    expect(choices).toHaveLength(1);
    expect(first).toBeDefined();
    const skips = logs.messages('warn');
    expect(skips).toHaveLength(23);
    expect(skips[0]).toMatch(
      /^Link import skipped photo \d+ from cdn\.test: 63000000 pixels, 1000000 left of the import's budget$/,
    );
  });

  it('takes each candidate from what is left: a small one after a skipped one still fits', async () => {
    const third = Math.floor(CHOICE_PIXEL_BUDGET / 3);
    const { deps, urls, previewed } = shop([
      third,
      third,
      third + 10_000_000,
      2_000_000,
    ]);

    const { choices } = await previewChoices(deps, urls);

    expect(choices.map((choice) => choice.url)).toEqual([
      'https://cdn.test/0',
      'https://cdn.test/1',
      'https://cdn.test/3',
    ]);
    expect(previewed.sort()).toEqual([0, 1, 3]);
  });

  it("leaves out refused and unreadable candidates and keeps the page's order", async () => {
    const { deps, urls } = shop(
      ['refused', 'unreadable', 1_000_000, 1_000_000, 1_000_000],
      // The fourth answers before the third.
      [2, 2, 20, 1, 1],
    );

    const { choices, first } = await previewChoices(deps, urls);

    expect(choices.map((choice) => choice.url)).toEqual([
      'https://cdn.test/2',
      'https://cdn.test/3',
      'https://cdn.test/4',
    ]);
    expect(choices[0].preview).toBe(
      `data:image/webp;base64,${Buffer.from('preview 2').toString('base64')}`,
    );
    // The first readable in the page's order is the one stored.
    expect(first?.url.href).toBe('https://cdn.test/2');
  });

  it('never fails the import for a candidate it cannot take', async () => {
    const unreadable = shop(['refused', 'unreadable', MAX_INPUT_PIXELS]);
    const over = shop([MAX_INPUT_PIXELS, MAX_INPUT_PIXELS]);

    await expect(
      previewChoices(unreadable.deps, unreadable.urls),
    ).resolves.toMatchObject({ choices: [{ url: 'https://cdn.test/2' }] });
    await expect(previewChoices(over.deps, over.urls)).resolves.toMatchObject({
      choices: [{ url: 'https://cdn.test/0' }],
    });
    await expect(previewChoices(over.deps, [])).resolves.toEqual({
      choices: [],
      first: undefined,
    });
  });
});

describe('readProductPage', () => {
  const page = (requests: FetchRequest[]) => ({
    fetch(url: string, request: FetchRequest) {
      requests.push(request);
      return Promise.resolve<FetchedResource>({
        kind: 'html',
        mediaType: 'text/html',
        charset: 'utf-8',
        body: Buffer.from('<title>Tee</title>'),
        truncated: false,
        url: new URL(url),
        redirects: 0,
      });
    },
  });

  // #698: the order mail's poll passes its product-link rule; link import's
  // own fetches and a caller passing nothing follow every redirect as before.
  it('asks for HTML and follows every redirect unless a caller judges them', async () => {
    const requests: FetchRequest[] = [];
    await readProductPage(page(requests), 'https://shop.test/p/1');
    const mayFollow = (url: URL) => url.pathname.startsWith('/p/');
    await readProductPage(page(requests), 'https://shop.test/p/1', mayFollow);
    expect(requests[0]).toEqual({ accept: ['html'] });
    expect(requests[0].mayFollow).toBeUndefined();
    expect(requests[1]).toEqual({ accept: ['html'], mayFollow });
  });
});
