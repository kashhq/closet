import { readFile } from 'node:fs/promises';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tapMisses } from '../../test/support/tap-area';
import {
  A11Y_VIEWPORT,
  injectMeasurers,
  MEASURE_LIMITS,
  measureInPage,
} from './a11y';

/**
 * The page audit's in-browser measurement against fixed HTML in a real
 * Chromium page (#1209; make ci-e2e runs it, not ci-unit): label boxes, hit areas and clipping need a layout
 * engine, so jsdom cannot stand in. One browser per file, a page per test;
 * nothing here touches the app or Postgres.
 */

let browser: Browser;
let axeSource: string;

beforeAll(async () => {
  browser = await chromium.launch();
  axeSource = await readFile(require.resolve('axe-core'), 'utf8');
});
afterAll(async () => {
  await browser.close();
});

async function loaded(html: string): Promise<Page> {
  const page = await browser.newPage({ viewport: A11Y_VIEWPORT });
  await page.setContent(
    `<!doctype html><html lang="en"><head><title>t</title></head><body style="margin:0">${html}</body></html>`,
  );
  await injectMeasurers(page, axeSource);
  return page;
}

async function measured(html: string) {
  const page = await loaded(html);
  try {
    return await page.evaluate(measureInPage, MEASURE_LIMITS);
  } finally {
    await page.close();
  }
}

describe('measureInPage', () => {
  it('counts a control through its label, and a link alone but not one in a sentence', async () => {
    const { targets } = await measured(`
      <style>.chip{display:block;width:48px;height:48px;margin:20px}
        .hidden{position:absolute;opacity:0;width:1px;height:1px}</style>
      <label class="chip" for="r">A</label><input id="r" class="hidden" type="radio" name="r">
      <p>Read the <a href="/terms">terms</a> first</p>
      <div><a href="/alone">Alone</a></div>`);
    expect(targets.map((t) => t.selector)).toEqual(['a "Alone"']);
  });

  it('measures only the text fields that are under the minimum', async () => {
    const { fields } = await measured(`
      <style>body *{font-size:12px}</style>
      <input name="text"><input name="big" style="font-size:16px"><textarea name="area"></textarea>
      <select name="pick"><option>a</option></select><div contenteditable="true" id="rich">x</div>
      <input type="hidden" name="h"><input type="checkbox" name="c"><input type="radio" name="r">
      <input type="submit" name="s" value="Go"><input type="file" name="f"><input name="off" disabled>`);
    expect(fields.map((f) => f.selector)).toEqual([
      'input[name=text]',
      'textarea[name=area]',
      'select[name=pick] "a"',
      'div#rich "x"',
    ]);
    expect(fields.every((f) => f.px === 12)).toBe(true);
  });

  it('describes an axe node from its own element and region', async () => {
    const { violations } = await measured(`
      <main id="page"><section id="hero"><img class="pic wide" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></section></main>`);
    const node = violations.find((v) => v.id === 'image-alt')?.nodes[0];
    expect(node?.element).toMatchObject({
      tag: 'img',
      classes: ['pic', 'wide'],
      region: { tag: 'section', name: 'hero' },
    });
  });

  it('freezes htmx while axe runs and lifts it after', async () => {
    const page = await loaded('<main><p>x</p></main>');
    try {
      await page.evaluate(() => {
        const w = window as unknown as {
          axe: { run: (...args: unknown[]) => Promise<unknown> };
          during: boolean[];
        };
        w.during = [];
        const run = w.axe.run.bind(w.axe);
        w.axe.run = (...args) => {
          // true when something cancelled the request htmx was about to send.
          const evt = new Event('htmx:beforeRequest', {
            cancelable: true,
            bubbles: true,
          });
          document.body.dispatchEvent(evt);
          w.during.push(evt.defaultPrevented);
          return run(...args);
        };
      });
      await page.evaluate(measureInPage, MEASURE_LIMITS);
      const { during, after } = await page.evaluate(() => {
        const evt = new Event('htmx:beforeRequest', {
          cancelable: true,
          bubbles: true,
        });
        document.body.dispatchEvent(evt);
        return {
          during: (window as unknown as { during: boolean[] }).during,
          after: evt.defaultPrevented,
        };
      });
      expect(during).toEqual([true]);
      expect(after).toBe(false);
    } finally {
      await page.close();
    }
  });
});

describe('tapMisses', () => {
  /** What #t's tap misses, or null when a tap anywhere on its disc lands. */
  async function miss(html: string) {
    const page = await loaded(html);
    try {
      await page.evaluate(`window.closetTapMisses = ${String(tapMisses)}`);
      return await page.evaluate(() => {
        const run = (window as unknown as { closetTapMisses: typeof tapMisses })
          .closetTapMisses;
        const target = document.querySelector('#t');
        if (!target) throw new Error('no #t');
        const [result] = run([target], 44);
        return result
          ? {
              width: result.width,
              height: result.height,
              hit: result.hit?.id || result.hit?.tagName || null,
            }
          : null;
      });
    } finally {
      await page.close();
    }
  }
  const sized = (w: number, h: number, extra = '') =>
    `<style>#t{display:block;margin:200px 100px;border:0;padding:0;width:${w}px;height:${h}px;${extra}}</style>`;

  it('passes a 44 px control, and one a pixel short (the tolerance), but fails 42 px', async () => {
    expect(await miss(`${sized(44, 44)}<button id="t"></button>`)).toBeNull();
    expect(await miss(`${sized(43, 43)}<button id="t"></button>`)).toBeNull();
    expect(
      await miss(`${sized(42, 42)}<button id="t"></button>`),
    ).toMatchObject({ width: 42, height: 42 });
  });

  it('counts a positioned ::after hit area', async () => {
    const html = `${sized(20, 20, 'position:relative')}
      <style>#t::after{content:'';position:absolute;inset:-12px}</style><button id="t"></button>`;
    expect(await miss(html)).toBeNull();
  });

  it('fails a control whose neighbour paints over its disc', async () => {
    const html = `${sized(44, 44)}<style>#n{display:block;width:44px;height:44px;margin:-244px 0 0 130px;padding:0;border:0}</style>
      <button id="t"></button><button id="n"></button>`;
    expect(await miss(html)).toMatchObject({ hit: 'n' });
  });

  it('keeps the disc inside the viewport, so an edge control still lands', async () => {
    const html = `<style>#t{position:fixed;left:0;top:300px;width:30px;height:30px;margin:0;padding:0;border:0}
      #t::after{content:'';position:absolute;inset:-7px -14px -7px -7px}</style><button id="t"></button>`;
    expect(await miss(html)).toBeNull();
  });

  it('ignores a pseudo-element its own overflow clips, but not a static one', async () => {
    const clipped = `${sized(20, 20, 'position:relative;overflow:hidden')}
      <style>#t::after{content:'';position:absolute;inset:-12px}</style><button id="t"></button>`;
    expect(await miss(clipped)).toMatchObject({ width: 20, height: 20 });
    // Static: its overflow does not clip a ::after placed against the wrapper.
    const wrapped = `<style>#w{position:relative;width:20px;height:20px;margin:200px 100px}
      #t{overflow:hidden;display:block;width:20px;height:20px;margin:0;padding:0;border:0}
      #t::after{content:'';position:absolute;inset:-12px}</style>
      <div id="w"><button id="t"></button></div>`;
    expect(await miss(wrapped)).toBeNull();
  });
});
