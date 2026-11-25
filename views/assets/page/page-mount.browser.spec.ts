import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bundlePageModule,
  closePage,
  type MountedPage,
  mountPage,
} from '../../../test/support/page-module-browser';

/**
 * page-mount.ts's engine (`watchMounts`, views/assets/mounts.ts) in a real
 * Chromium page (`npm run test:audit-browser`, make ci-e2e), driven by a
 * table of its own: the real table imports the importmap's bare names, which
 * only a served page resolves. Each mount records its element's id in
 * `window.mounted`; `window.fire(selector)` dispatches `htmx:load` as htmx
 * does, on what a swap inserted (and on the body as htmx starts).
 *
 * The rule (#672): an element mounts at most once, however often a load
 * reaches it (the body's, an ancestor's, the same subtree twice), and an
 * element put in an old one's place mounts afresh, except a `once` mount's,
 * which a history restore never runs again.
 */

const ENTRY = `
import { once, watchMounts } from './views/assets/mounts.ts';
window.mounted = [];
window.fire = (selector) =>
  document
    .querySelector(selector)
    .dispatchEvent(new CustomEvent('htmx:load', { bubbles: true }));
const record = (element) => { window.mounted.push(element.id); };
watchMounts({
  styling: record,
  locate: async (element) => { await Promise.resolve(); record(element); },
  'snap-strips': () => { throw new Error('broken on purpose'); },
  'open-sheet': once(async (element) => { await Promise.resolve(); record(element); }),
});
`;

const MARKUP = `
  <div id="outer">
    <div id="rows" data-page-module="styling"></div>
    <section id="part" data-page-module="locate"><p>inside</p></section>
  </div>
  <template id="broken" data-page-module="snap-strips"></template>
  <div id="slot"></div>
  <dialog id="sheet" data-page-module="open-sheet"></dialog>`;

declare global {
  interface Window {
    mounted: string[];
    fire(selector: string): void;
  }
}

let browser: Browser;
let bundle: string;

beforeAll(async () => {
  bundle = await bundlePageModule(ENTRY);
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

async function withPage(test: (mounted: MountedPage) => Promise<void>) {
  const mounted = await mountPage(browser, { markup: MARKUP, bundle });
  try {
    await test(mounted);
  } finally {
    await closePage(mounted.page);
  }
}

/**
 * What has mounted since the page loaded, once every mount started so far
 * has run: a mount runs in a microtask, so a task queued after it sees all.
 */
function mountedSoFar(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    await new Promise((settled) => setTimeout(settled));
    return window.mounted;
  });
}

describe('page-mount', () => {
  it('mounts each marked element of the loaded page once', async () => {
    await withPage(async ({ page }) => {
      expect(await mountedSoFar(page)).toEqual(['rows', 'part', 'sheet']);
    });
  });

  it('mounts nothing again when a load reaches a mounted element', async () => {
    await withPage(async ({ page }) => {
      await page.evaluate(() => {
        // The body's at htmx's start, an ancestor's, the element's own, twice.
        for (const selector of ['body', '#outer', '#rows', '#part', '#part']) {
          window.fire(selector);
        }
      });
      expect(await mountedSoFar(page)).toEqual(['rows', 'part', 'sheet']);
    });
  });

  it('mounts an element a swap puts in a mounted one’s place, once', async () => {
    await withPage(async ({ page }) => {
      await page.evaluate(() => {
        // hx-swap="outerHTML" on #rows: a new element of the same id.
        document.querySelector('#rows')!.outerHTML =
          '<div id="rows" data-page-module="styling"></div>';
        window.fire('#rows');
        window.fire('#outer');
      });
      expect(await mountedSoFar(page)).toEqual([
        'rows',
        'part',
        'sheet',
        'rows',
      ]);
    });
  });

  it('mounts the marked elements inside what a swap inserted', async () => {
    await withPage(async ({ page }) => {
      await page.evaluate(() => {
        document.querySelector('#slot')!.innerHTML =
          '<div id="fresh"><span id="deep" data-page-module="locate"></span></div>';
        window.fire('#fresh');
      });
      expect(await mountedSoFar(page)).toEqual([
        'rows',
        'part',
        'sheet',
        'deep',
      ]);
    });
  });

  it('runs a once mount on its first visit and never on a history restore', async () => {
    await withPage(async ({ page }) => {
      const restored = await page.evaluate(async () => {
        await new Promise((settled) => setTimeout(settled));
        // What htmx does going Back: the body's markup as it was left,
        // put back, then htmx:load on the body.
        const snapshot = document.body.innerHTML;
        document.body.innerHTML = snapshot;
        window.fire('body');
        return snapshot;
      });
      expect(restored).not.toContain('data-page-module="open-sheet"');
      // The bindings mount afresh on the restored elements; the sheet does not.
      expect(await mountedSoFar(page)).toEqual([
        'rows',
        'part',
        'sheet',
        'rows',
        'part',
      ]);
    });
  });

  it('logs a mount that fails and a name it has no module for, and mounts the rest', async () => {
    await withPage(async ({ page, warnings }) => {
      const errors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.evaluate(() => {
        document.querySelector('#slot')!.innerHTML =
          '<i id="unknown" data-page-module="no-such-module"></i>' +
          '<i id="again" data-page-module="snap-strips"></i>' +
          '<b id="ok" data-page-module="styling"></b>';
        window.fire('#slot');
      });
      expect(await mountedSoFar(page)).toEqual(['rows', 'part', 'sheet', 'ok']);
      expect(warnings).toEqual([
        '[page-mount] no module named "no-such-module"',
      ]);
      // The page's own broken template failed at load, before this
      // listener; the swapped one is heard.
      expect(errors).toEqual([
        expect.stringContaining('[page-mount] snap-strips failed to mount'),
      ]);
    });
  });
});
