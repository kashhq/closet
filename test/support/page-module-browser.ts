import { type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';

/**
 * Shared by the browser specs of the client modules
 * (views/assets/page/*.browser.spec.ts, Vitest project `audit-browser`). It
 * lives here, not beside the modules: the page build bundles every `page/*.ts`
 * that is not a `.spec.ts` (pageModuleEntries).
 */

/**
 * Bundles `contents` (an entry importing a page module by its repo path) as
 * the page build does: from source, `confirm-sheet` resolved to its public file.
 */
export async function bundlePageModule(contents: string): Promise<string> {
  const result = await build({
    stdin: { contents, resolveDir: '.', loader: 'ts' },
    alias: { 'confirm-sheet': 'public/js/confirm-sheet.js' },
    bundle: true,
    format: 'iife',
    write: false,
    logLevel: 'warning',
  });
  return result.outputFiles[0].text;
}

export interface MountedPage {
  page: Page;
  /** The console warnings the page logged: a module's failure paths. */
  warnings: string[];
}

/**
 * A page holding `markup`, with `prepare` run in it before `bundle` loads (a
 * module that reads the DOM at load needs the markup first, one that fetches
 * needs its fake server first). `hasTouch` gives the page real touch input.
 */
export async function mountPage(
  browser: Browser,
  options: {
    markup: string;
    bundle: string;
    prepare?: (page: Page) => Promise<void>;
    hasTouch?: boolean;
  },
): Promise<MountedPage> {
  const context = await browser.newContext({ hasTouch: options.hasTouch });
  const page = await context.newPage();
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text());
  });
  await page.setContent(
    `<!doctype html><html lang="en"><head><title>t</title></head><body>${options.markup}</body></html>`,
  );
  await options.prepare?.(page);
  await page.addScriptTag({ content: options.bundle });
  return { page, warnings };
}

/** Closes the page with the context mountPage made for it. */
export async function closePage(page: Page): Promise<void> {
  await page.context().close();
}
