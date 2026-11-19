import { writeFile } from 'node:fs/promises';
import { AxeBuilder } from '@axe-core/playwright';
import { type Browser, chromium, type Page } from '@playwright/test';
import {
  type A11yReport,
  FIELD_FONT,
  countKinds,
  FIELD_FONT_MIN_PX,
  type Offender,
  type PageA11y,
  TARGET_MIN_PX,
  TARGET_SIZE,
  TARGET_TOLERANCE_PX,
} from './a11y-report';
import type { Actor, AuditRequest, Fixture } from './fixture';

/**
 * The page audit's accessibility pass (#722): every page step a browser can
 * open (a plain GET answering 200) loaded in Chromium at phone width, then
 * axe-core's violations per rule, the form fields an iPhone zooms into
 * (under 16 px) and the tap targets under 44 px, counted per page. The
 * counts go into the report (`a11y`) and `--compare` fails on any increase:
 * the baseline holds what exists, a PR may only lower it.
 *
 * Read-only: the browser's writes (a beacon, a vitals post) are answered 204
 * in the browser, so the walk after it starts on the seed as it was and no
 * rate-limit budget it paces has been spent. axe is injected from
 * node_modules: nothing leaves the box.
 */

/** iPhone 12 to 15's CSS width (screenshots.spec.ts shoots the same). */
export const A11Y_VIEWPORT = { width: 390, height: 844 } as const;
export interface A11yVisit {
  /** The step's id (`<issue> <name>`): what the compare matches on. */
  id: string;
  issue: number;
  name: string;
  target: string;
  request: AuditRequest;
}

/** What the pass learns across pages: the rules that fired, axe's version. */
interface Found {
  rules: A11yReport['rules'];
  axeVersion: string;
}

interface Measured {
  counts: Record<string, number>;
  offenders: Offender[];
}

/**
 * The text-entry fields iOS zooms into, and the tap targets, measured in the
 * page. Runs in the browser (serialized by page.evaluate): no closures, no
 * imports.
 */
function measureInPage(limits: { fontMin: number; targetMin: number }): {
  fields: { selector: string; signature: string; px: number }[];
  targets: {
    selector: string;
    signature: string;
    width: number;
    height: number;
  }[];
} {
  const describe = (el: Element): string => {
    const id = el.id ? `#${el.id}` : '';
    const name = el.getAttribute('name');
    const label =
      el.getAttribute('aria-label') ??
      (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}${id}${name ? `[name=${name}]` : ''}${label ? ` "${label}"` : ''}`;
  };
  // The element's kind, free of its text and its place: tag, type, role,
  // field name and class list. A grid of seeded cells is one kind.
  const kind = (el: Element): string =>
    [
      el.tagName.toLowerCase(),
      el.getAttribute('type'),
      el.getAttribute('role'),
      el.getAttribute('name'),
      [...el.classList].sort().join('.'),
    ]
      .filter(Boolean)
      .join(' ');
  const NOT_TEXT = new Set([
    'hidden',
    'checkbox',
    'radio',
    'range',
    'file',
    'submit',
    'button',
    'reset',
    'color',
    'image',
  ]);
  // Every focusable text field counts, shown or not: a field in a closed
  // sheet zooms the page as soon as the sheet opens, and its computed font
  // size is known without layout.
  const fields = [
    ...document.querySelectorAll<HTMLElement>(
      'input, select, textarea, [contenteditable=""], [contenteditable="true"]',
    ),
  ]
    .filter(
      (el) =>
        !(el instanceof HTMLInputElement && NOT_TEXT.has(el.type)) &&
        !el.matches(':disabled'),
    )
    .map((el) => ({
      selector: describe(el),
      signature: kind(el),
      px: parseFloat(getComputedStyle(el).fontSize),
    }))
    .filter((field) => field.px < limits.fontMin);

  const shown = (el: Element): DOMRect | undefined => {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      return undefined;
    }
    if (getComputedStyle(el).pointerEvents === 'none') return undefined;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 ? box : undefined;
  };
  // A link inside running text is exempt (WCAG 2.5.8's inline exception):
  // its size is the sentence's.
  const inline = (el: Element): boolean =>
    el.tagName === 'A' &&
    getComputedStyle(el).display === 'inline' &&
    [...(el.parentElement?.childNodes ?? [])].some(
      (node) =>
        node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim(),
    );
  const targets = [
    ...document.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, ' +
        '[role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], ' +
        '[role="switch"], [role="menuitem"], [role="option"]',
    ),
  ].flatMap((el) => {
    if (el.closest('[inert]') || el.matches(':disabled')) return [];
    if (inline(el)) return [];
    // A control is tapped through its label too: a visually hidden radio
    // behind a chip is the chip's size.
    const labels =
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
        ? [...(el.labels ?? [])]
        : [];
    const boxes = [el, ...labels].flatMap((part) => shown(part) ?? []);
    if (boxes.length === 0) return [];
    const big = boxes.some(
      (box) => box.width >= limits.targetMin && box.height >= limits.targetMin,
    );
    if (big) return [];
    // The biggest of them: a hidden input's 1 px says nothing of its chip.
    const box = boxes.reduce((a, b) =>
      b.width * b.height > a.width * a.height ? b : a,
    );
    return [
      {
        selector: describe(el),
        signature: kind(el),
        width: Math.round(box.width * 10) / 10,
        height: Math.round(box.height * 10) / 10,
      },
    ];
  });
  return { fields, targets };
}

function cookieValue(actor: Actor): string {
  return actor.cookie.slice(actor.cookie.indexOf('=') + 1);
}

async function measurePage(page: Page, found: Found): Promise<Measured> {
  const offenders: Offender[] = [];
  const axe = await new AxeBuilder({ page }).analyze();
  found.axeVersion = axe.testEngine.version;
  const { rules } = found;
  for (const violation of axe.violations) {
    rules[violation.id] = {
      impact: violation.impact ?? 'minor',
      help: violation.help,
    };
    for (const node of violation.nodes) {
      offenders.push({
        measure: violation.id,
        selector: node.target.join(' '),
        signature: node.target.join(' '),
        detail: node.failureSummary ?? '',
      });
    }
  }
  const { fields, targets } = await page.evaluate(measureInPage, {
    fontMin: FIELD_FONT_MIN_PX,
    targetMin: TARGET_MIN_PX - TARGET_TOLERANCE_PX,
  });
  offenders.push(
    ...fields.map((field) => ({
      measure: FIELD_FONT,
      selector: field.selector,
      signature: field.signature,
      detail: `${field.px} px`,
    })),
    ...targets.map((target) => ({
      measure: TARGET_SIZE,
      selector: target.selector,
      signature: target.signature,
      detail: `${target.width} × ${target.height} px`,
    })),
  );
  return { counts: countKinds(offenders), offenders };
}

async function visit(
  browser: Browser,
  origin: string,
  fixture: Fixture,
  step: A11yVisit,
  found: Found,
): Promise<Measured> {
  const context = await browser.newContext({
    baseURL: origin,
    viewport: A11Y_VIEWPORT,
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
    // The worker would answer from its cache and route past page.route.
    serviceWorkers: 'block',
  });
  try {
    const actor =
      step.request.as === undefined ? fixture.theo : step.request.as;
    if (actor) {
      await context.addCookies([
        { name: 'access_token', value: cookieValue(actor), url: origin },
      ]);
    }
    await context.route('**/*', (route) =>
      ['GET', 'HEAD'].includes(route.request().method())
        ? route.continue()
        : route.fulfill({ status: 204 }),
    );
    const page = await context.newPage();
    const res = await page.goto(step.request.url, { waitUntil: 'load' });
    if (res?.status() !== 200) {
      throw new Error(`answered ${res?.status() ?? 'nothing'}, not 200`);
    }
    // htmx's load-triggered fragments, then the fonts the contrast check reads.
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    return await measurePage(page, found);
  } finally {
    await context.close();
  }
}

export interface A11yPass {
  report: A11yReport;
  failures: string[];
}

/**
 * Serves the fixture's app on a loopback port (it stays up until the
 * fixture closes) and visits each page. A page that fails is reported and
 * the pass goes on; `detailFile` gets every offending node.
 */
export async function auditAccessibility(
  fixture: Fixture,
  visits: readonly A11yVisit[],
  detailFile: string,
): Promise<A11yPass> {
  const origin = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch();
  const found: Found = { rules: {}, axeVersion: 'unknown' };
  const pages: PageA11y[] = [];
  const failures: string[] = [];
  const detail: Record<string, Offender[]> = {};
  try {
    for (const step of visits) {
      const label = `#${step.issue} ${step.name} (${step.target})`;
      try {
        const { counts, offenders } = await visit(
          browser,
          origin,
          fixture,
          step,
          found,
        );
        const { id, issue, name, target } = step;
        pages.push({ id, issue, name, target, counts });
        detail[step.id] = offenders;
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        console.log(`${label}: ${total} accessibility violation kind(s)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${label} (accessibility): ${message}`);
        console.error(`${label}: accessibility pass FAILED ${message}`);
      }
    }
  } finally {
    await browser.close();
  }
  await writeFile(detailFile, `${JSON.stringify(detail, null, 1)}\n`);
  return {
    report: {
      viewport: { ...A11Y_VIEWPORT },
      axeVersion: found.axeVersion,
      rules: found.rules,
      pages,
    },
    failures,
  };
}
