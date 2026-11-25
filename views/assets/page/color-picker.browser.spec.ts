import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  colorOption,
  colorPicker,
  colorPickerPart,
  colorPill,
} from '../../../src/web/page-contract';
import {
  bundlePageModule,
  closePage,
  mountPage,
} from '../../../test/support/page-module-browser';

/**
 * The garment form's colour field in a real Chromium page (run by
 * `npm run test:audit-browser`, make ci-e2e): the pills follow the ticks, the
 * search narrows the list and says when nothing is left, Enter in it does not
 * submit the form, Clear all unticks, a tap outside closes the picker, and
 * htmx:load re-reads ticks a history restore left out of step with the pills.
 * The module is bundled from source; the markup is the shape of
 * garment-form.tsx's ColorPicker, three colours long, with `red` ticked.
 */

const COLORS = ['red', 'blue', 'green'];
const attrs = (record: Record<string, string>) =>
  Object.entries(record)
    .map(([name, value]) => `${name}="${value}"`)
    .join(' ');
const part = (name: Parameters<typeof colorPickerPart>[0]) =>
  attrs(colorPickerPart(name));

const MARKUP = `
  <form id="form" onsubmit="window.submitted = true; return false">
    <details id="picker" ${attrs(colorPicker())}>
      <summary>
        <span id="placeholder" ${part('placeholder')} hidden>Select</span>
        ${COLORS.map(
          (color) =>
            `<span id="pill-${color}" ${attrs(colorPill(color))} ${color === 'red' ? '' : 'hidden'}>${color}</span>`,
        ).join('')}
      </summary>
      <input id="search" type="text" ${part('search')}>
      ${COLORS.map(
        (color) =>
          `<label id="option-${color}" ${attrs(colorOption(color))}><input type="checkbox" name="color" value="${color}" ${color === 'red' ? 'checked' : ''}>${color}</label>`,
      ).join('')}
      <div id="empty" ${part('empty')} hidden>No matches</div>
      <span id="count" ${part('count')}>1</span>
      <button id="clear" type="button" ${part('clear')}>Clear all</button>
    </details>
  </form>
  <p id="outside">outside</p>`;

let browser: Browser;
let bundle: string;

beforeAll(async () => {
  bundle = await bundlePageModule(
    "import './views/assets/page/color-picker.ts';",
  );
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

async function withPicker(test: (page: Page) => Promise<void>) {
  const { page } = await mountPage(browser, { markup: MARKUP, bundle });
  try {
    await test(page);
  } finally {
    await closePage(page);
  }
}

const open = (page: Page) => page.click('#picker > summary');

/** Which of the colours' pills are shown, in COLORS order. */
const shownPills = (page: Page) =>
  Promise.all(COLORS.map((color) => page.isVisible(`#pill-${color}`)));

describe('the colour field', () => {
  it('shows the pill and count of what is ticked, the placeholder for none', async () => {
    await withPicker(async (page) => {
      await open(page);
      expect(await shownPills(page)).toEqual([true, false, false]);
      await page.check('#option-blue input');
      expect(await shownPills(page)).toEqual([true, true, false]);
      expect(await page.textContent('#count')).toBe('2');
      await page.uncheck('#option-red input');
      await page.uncheck('#option-blue input');
      expect(await shownPills(page)).toEqual([false, false, false]);
      expect(await page.isVisible('#placeholder')).toBe(true);
      expect(await page.textContent('#count')).toBe('0');
    });
  });

  it('narrows the list by the search and says when nothing is left', async () => {
    await withPicker(async (page) => {
      await open(page);
      await page.fill('#search', 'BLU');
      expect(
        await Promise.all(
          COLORS.map((color) => page.isVisible(`#option-${color}`)),
        ),
      ).toEqual([false, true, false]);
      expect(await page.isVisible('#empty')).toBe(false);
      await page.fill('#search', 'zzz');
      expect(await page.isVisible('#empty')).toBe(true);
      await page.fill('#search', '');
      expect(await page.isVisible('#option-red')).toBe(true);
      expect(await page.isVisible('#empty')).toBe(false);
    });
  });

  it('does not submit the form on Enter in the search box', async () => {
    await withPicker(async (page) => {
      await open(page);
      await page.focus('#search');
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => 'submitted' in window)).toBe(false);
    });
  });

  it('unticks everything and clears the search on Clear all', async () => {
    await withPicker(async (page) => {
      await open(page);
      await page.check('#option-green input');
      await page.fill('#search', 'gre');
      await page.click('#clear');
      expect(await page.isChecked('#option-red input')).toBe(false);
      expect(await page.isChecked('#option-green input')).toBe(false);
      expect(await shownPills(page)).toEqual([false, false, false]);
      expect(await page.isVisible('#placeholder')).toBe(true);
      expect(await page.inputValue('#search')).toBe('');
      expect(await page.isVisible('#option-red')).toBe(true);
    });
  });

  it('closes on a tap outside, and stays open for a tap inside', async () => {
    await withPicker(async (page) => {
      await open(page);
      await page.click('#option-blue');
      expect(await page.getAttribute('#picker', 'open')).not.toBeNull();
      await page.click('#outside');
      expect(await page.getAttribute('#picker', 'open')).toBeNull();
    });
  });

  it('re-reads the ticks of content htmx loads, as after a history restore', async () => {
    await withPicker(async (page) => {
      // The restored snapshot keeps the pills' markup but not the ticks.
      await page.evaluate(() => {
        (
          document.querySelector('#option-red input') as HTMLInputElement
        ).checked = false;
        (
          document.querySelector('#option-blue input') as HTMLInputElement
        ).checked = true;
      });
      expect(await shownPills(page)).toEqual([true, false, false]);
      await page.evaluate(() => {
        document
          .getElementById('form')!
          .dispatchEvent(new CustomEvent('htmx:load', { bubbles: true }));
      });
      expect(await shownPills(page)).toEqual([false, true, false]);
      expect(await page.textContent('#count')).toBe('1');
    });
  });
});
