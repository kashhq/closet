import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checksOnTap,
  closesMenu,
  closesSheet,
  copyButton,
  dismiss,
  dismissable,
  nativeWithout,
  photoPick,
  resetsOnClose,
  selectsOnTap,
  submitsVia,
} from '../../../src/web/page-contract';
import {
  bundlePageModule,
  closePage,
  mountPage,
} from '../../../test/support/page-module-browser';

/**
 * The delegated actions (actions.ts, #672) in a real Chromium page (run by
 * `npm run test:audit-browser`, make ci-e2e): each case builds the smallest
 * markup the views render for one `data-*` behaviour from page-contract's own
 * helpers, so a renamed attribute breaks the fixture and the view together.
 */

const attrs = (record: Record<string, string | undefined>) =>
  Object.entries(record)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}="${value}"`)
    .join(' ');

declare global {
  interface Window {
    log: string[];
  }
}

/**
 * `note` appends to `window.log`. A submit is logged only if nothing
 * prevented it (a prevented one posts nothing), and then stopped here so the
 * page does not navigate.
 */
const NOTE = `window.log = []; const note = (name) => window.log.push(name);
  document.addEventListener('submit', (e) => { if (e.defaultPrevented) return; e.preventDefault(); note('submit:' + e.target.id); });`;

let browser: Browser;
let bundle: string;

beforeAll(async () => {
  bundle = await bundlePageModule("import './views/assets/page/actions.ts';", {
    'photo-input': 'test/support/photo-input-stub.ts',
  });
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

async function withPage(
  markup: string,
  test: (page: Page) => Promise<void>,
  prepare?: (page: Page) => Promise<void>,
) {
  const { page } = await mountPage(browser, {
    markup: `<script>${NOTE}</script>${markup}`,
    bundle,
    prepare,
  });
  try {
    await test(page);
  } finally {
    await closePage(page);
  }
}

const log = (page: Page) => page.evaluate(() => window.log);

describe('the delegated actions', () => {
  it('stops htmx for a link whose form is absent, lets it through when present', async () => {
    const link = `<a id="link" href="#x" ${attrs(nativeWithout('filters'))}>Clear</a>
      <script>document.getElementById('link').addEventListener('click', () => note('htmx'));</script>`;
    await withPage(link, async (page) => {
      await page.click('#link');
      expect(await log(page)).toEqual([]);
    });
    await withPage(`<form id="filters"></form>${link}`, async (page) => {
      await page.click('#link');
      expect(await log(page)).toEqual(['htmx']);
    });
  });

  it('submits the form it names with htmx loaded, posts itself without', async () => {
    const markup = `
      <form id="search" ${attrs(submitsVia('filters'))}><button id="go">Go</button></form>
      <form id="filters"></form>`;
    await withPage(
      markup,
      async (page) => {
        await page.click('#go');
        expect(await log(page)).toEqual(['submit:filters']);
      },
      (page) => page.evaluate(() => void Object.assign(window, { htmx: {} })),
    );
    await withPage(markup, async (page) => {
      await page.click('#go');
      expect(await log(page)).toEqual(['submit:search']);
    });
  });

  it('resets the form of a dialog flagged to on close, which does not bubble', async () => {
    const dialog = (flag: boolean, id: string) =>
      `<dialog id="${id}" ${attrs(resetsOnClose(flag))}><form><input id="${id}-in" value="a"></form></dialog>`;
    await withPage(dialog(true, 'on') + dialog(false, 'off'), async (page) => {
      for (const id of ['on', 'off']) {
        await page.evaluate(
          (id) =>
            document.querySelector<HTMLDialogElement>(`#${id}`)?.showModal(),
          id,
        );
        await page.fill(`#${id}-in`, 'b');
        await page.evaluate(
          (id) => document.querySelector<HTMLDialogElement>(`#${id}`)?.close(),
          id,
        );
      }
      await page.waitForFunction(
        () => document.querySelector<HTMLInputElement>('#on-in')?.value === 'a',
      );
      expect(await page.inputValue('#off-in', { timeout: 1000 })).toBe('b');
    });
  });

  it('checks the named input before the control’s own listeners run', async () => {
    const markup = `<input type="radio" id="choice" name="o">
      <button id="plan" ${attrs(checksOnTap('choice'))}>Plan</button>
      <script>document.getElementById('plan').addEventListener('click', () =>
        note('opener sees ' + document.getElementById('choice').checked));</script>`;
    await withPage(markup, async (page) => {
      await page.click('#plan');
      expect(await log(page)).toEqual(['opener sees true']);
    });
  });

  it('closes the dialog a cancel button sits in', async () => {
    await withPage(
      `<dialog id="d"><button id="cancel" ${attrs(closesSheet())}>Cancel</button></dialog>`,
      async (page) => {
        await page.evaluate(() =>
          document.querySelector<HTMLDialogElement>('#d')?.showModal(),
        );
        await page.click('#cancel');
        expect(
          await page.evaluate(
            () => document.querySelector<HTMLDialogElement>('#d')?.open,
          ),
        ).toBe(false);
      },
    );
  });

  it('closes the menu a control in a details sits in', async () => {
    await withPage(
      `<details id="m" open><summary>Menu</summary><button id="item" ${attrs(closesMenu())}>Item</button></details>`,
      async (page) => {
        await page.click('#item');
        expect(
          await page.evaluate(
            () => document.querySelector<HTMLDetailsElement>('#m')?.open,
          ),
        ).toBe(false);
      },
    );
  });

  it('copies the text and flashes the button, then restores it', async () => {
    await withPage(
      `<button id="copy" class="resting" ${attrs(copyButton('hello', 'resting', 'flashed'))}>Copy</button>`,
      async (page) => {
        await page.click('#copy');
        await page.waitForFunction(() =>
          document.querySelector('#copy')?.classList.contains('flashed'),
        );
        expect(
          await page.evaluate(
            () => (window as unknown as { copied: string }).copied,
          ),
        ).toBe('hello');
        await page.waitForFunction(() =>
          document.querySelector('#copy')?.classList.contains('resting'),
        );
      },
      (page) =>
        page.evaluate(() => {
          Object.defineProperty(navigator, 'clipboard', {
            value: {
              writeText: (text: string) => {
                (window as unknown as { copied: string }).copied = text;
                return Promise.resolve();
              },
            },
          });
        }),
    );
  });

  it('selects the text of a read-only field on a tap', async () => {
    await withPage(
      `<input id="link" readonly value="https://closet.test/s/abc" ${attrs(selectsOnTap())}>`,
      async (page) => {
        await page.click('#link');
        expect(
          await page.evaluate(() => {
            const field = document.querySelector<HTMLInputElement>('#link');
            return field?.value.slice(
              field.selectionStart ?? 0,
              field.selectionEnd ?? 0,
            );
          }),
        ).toBe('https://closet.test/s/abc');
      },
    );
  });

  it('dismisses only the idea whose button is tapped, posting nothing', async () => {
    const idea = (id: string) =>
      `<li id="${id}" ${attrs(dismissable())}><button id="${id}-x" ${attrs(dismiss())}>x</button></li>`;
    await withPage(`<ul>${idea('one')}${idea('two')}</ul>`, async (page) => {
      await page.click('#one-x');
      expect(await page.locator('#one').count()).toBe(0);
      expect(await page.locator('#two').count()).toBe(1);
      expect(await log(page)).toEqual([]);
    });
  });

  it('submits the form after a photo is prepared, and not for an empty choice', async () => {
    await withPage(
      `<form id="up"><input id="pick" type="file" ${attrs(photoPick())}></form>`,
      async (page) => {
        await page.setInputFiles('#pick', []);
        await page.evaluate(() => {
          const transfer = new DataTransfer();
          transfer.items.add(new File(['x'], 'a.jpg', { type: 'image/jpeg' }));
          const input = document.querySelector<HTMLInputElement>('#pick');
          if (!input) return;
          input.files = transfer.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForFunction(() => window.log.length > 0);
        expect(await log(page)).toEqual(['submit:up']);
      },
    );
  });
});
