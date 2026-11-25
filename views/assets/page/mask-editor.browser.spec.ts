import path from 'node:path';
import { type Browser, chromium, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EDIT_MASK_ID, MASK_EDITOR_IDS } from '../../../src/web/page-contract';

/**
 * The mask editor in a real Chromium page (run by `npm run test:audit-browser`,
 * make ci-e2e): every way out of the dialog (Skip, the backdrop, Escape) must
 * enable the pencil again, and an Accept whose canvas cannot encode is a
 * failure, never a silent close. The module is bundled from source as the page
 * build does; the markup is the shape of garment-page.tsx's MaskEditorDialog
 * and garment-photo.tsx's pencil; the stored photos and the save are routed.
 */

const ORIGIN = 'https://closet.test';
const SAVE_URL = `${ORIGIN}/wardrobe/1/nobg`;
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const ids = MASK_EDITOR_IDS;
const MARKUP = `
  <div id="garment-photo-slot"><figure>
    <img alt="">
    <button id="${EDIT_MASK_ID}" type="button"
      data-original-url="${ORIGIN}/file/original" data-nobg-url="${ORIGIN}/file/nobg"
      data-save-url="${SAVE_URL}">Edit</button>
  </figure></div>
  <dialog id="${ids.dialog}" data-sheet="dialog" aria-label="Edit cutout">
    <div class="modal-box">
      <button id="${ids.erase}" type="button" aria-pressed="true">Erase</button>
      <button id="${ids.restore}" type="button" aria-pressed="false">Restore</button>
      <input id="${ids.size}" type="range" min="4" max="80" value="20">
      <canvas id="${ids.canvas}"></canvas>
      <button id="${ids.skip}" type="button">Skip</button>
      <button id="${ids.accept}" type="button">Accept</button>
    </div>
    <form method="dialog" class="modal-backdrop"><button id="backdrop">Close</button></form>
  </dialog>`;

let browser: Browser;
let bundle: string;

beforeAll(async () => {
  const root = path.resolve(__dirname, '../../..');
  const result = await build({
    stdin: {
      contents:
        "import { bindMaskEditor } from './views/assets/page/mask-editor.ts'; bindMaskEditor(document.getElementById('garment-photo-slot'));",
      resolveDir: root,
      loader: 'ts',
    },
    alias: { 'confirm-sheet': path.join(root, 'public/js/confirm-sheet.js') },
    bundle: true,
    format: 'iife',
    write: false,
    logLevel: 'warning',
  });
  bundle = result.outputFiles[0].text;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

async function mounted(): Promise<{ page: Page; warnings: string[] }> {
  const page = await browser.newPage();
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text());
  });
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = route.request().url();
    if (url === SAVE_URL) {
      return route.fulfill({
        json: {
          originalUrl: `${ORIGIN}/file/original2`,
          nobgUrl: `${ORIGIN}/file/nobg2`,
        },
      });
    }
    if (url === `${ORIGIN}/`) {
      return route.fulfill({ contentType: 'text/html', body: '<html></html>' });
    }
    return route.fulfill({ contentType: 'image/png', body: ONE_PIXEL_PNG });
  });
  await page.goto(`${ORIGIN}/`);
  await page.setContent(
    `<!doctype html><html lang="en"><head><title>t</title></head><body>${MARKUP}</body></html>`,
  );
  await page.addScriptTag({ content: bundle });
  return { page, warnings };
}

async function openEditor(page: Page) {
  await page.click(`#${EDIT_MASK_ID}`);
  await page.waitForSelector(`#${ids.dialog}[open]`);
  expect(await page.isDisabled(`#${EDIT_MASK_ID}`)).toBe(true);
}

async function pencilEnabled(page: Page) {
  await expect
    .poll(() => page.isEnabled(`#${EDIT_MASK_ID}`), { timeout: 5000 })
    .toBe(true);
}

describe('the mask editor', () => {
  const ways: [string, (page: Page) => Promise<void>][] = [
    ['Skip', (page) => page.click(`#${ids.skip}`)],
    ['the backdrop', (page) => page.click('#backdrop')],
    ['Escape', (page) => page.keyboard.press('Escape')],
  ];

  it.each(ways)(
    'enables the pencil again when closed by %s',
    async (_, close) => {
      const { page, warnings } = await mounted();
      try {
        await openEditor(page);
        await close(page);
        await pencilEnabled(page);
        expect(
          await page.evaluate(
            (id) => document.getElementById(id)?.hasAttribute('open'),
            ids.dialog,
          ),
        ).toBe(false);
        expect(warnings).toEqual([]);
      } finally {
        await page.close();
      }
    },
  );

  it('saves on Accept and enables the pencil with the new URLs', async () => {
    const { page } = await mounted();
    try {
      await openEditor(page);
      await page.click(`#${ids.accept}`);
      await pencilEnabled(page);
      expect(await page.getAttribute(`#${EDIT_MASK_ID}`, 'data-nobg-url')).toBe(
        `${ORIGIN}/file/nobg2`,
      );
    } finally {
      await page.close();
    }
  });

  it('takes the failure path, not a silent close, when Accept cannot encode', async () => {
    const { page, warnings } = await mounted();
    try {
      await page.evaluate(() => {
        HTMLCanvasElement.prototype.toBlob = (callback) => callback(null);
      });
      await openEditor(page);
      await page.click(`#${ids.accept}`);
      await pencilEnabled(page);
      expect(warnings.some((w) => w.includes('the edit failed'))).toBe(true);
      expect(await page.getAttribute(`#${EDIT_MASK_ID}`, 'data-nobg-url')).toBe(
        `${ORIGIN}/file/nobg`,
      );
    } finally {
      await page.close();
    }
  });
});
