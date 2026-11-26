import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Browser, chromium, type Page } from '@playwright/test';
import type Axe from 'axe-core';
import {
  type A11yReport,
  designClassesOf,
  type ElementDescriptor,
  FIELD_FONT,
  FIELD_FONT_MIN_PX,
  kindOf,
  type Offender,
  runWhileStill,
  STILL_RUN_ATTEMPTS,
  tally,
  type PageA11y,
  TARGET_MIN_PX,
  TARGET_SIZE,
  TARGET_TOLERANCE_PX,
} from './a11y-report';
import { tapMisses } from '../../test/support/tap-area';
import type { Actor, AuditRequest, Fixture } from './fixture';
import { type Step, stepId } from './walk';

/**
 * The page audit's accessibility pass (#722): every page step a browser can
 * open (a plain GET answering 200) loaded in Chromium at phone width, then
 * axe-core's violations per rule, the form fields an iPhone zooms into
 * (under 16 px) and the tap targets under 44 px, counted per page. The
 * counts and violating kinds go into the report (`a11y`); `--compare` fails on a
 * kind the baseline lacks and warns on a node-count rise.
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
  /** designClassesOf main.css and daisyUI's component sheets: the classes a kind keeps. */
  design: ReadonlySet<string>;
  /** axe-core's browser build, evaluated into each page before the run. */
  axeSource: string;
}

const ROOT = join(__dirname, '..', '..');

/** The design system's class names: main.css's own and every daisyUI component's. */
async function designClasses(): Promise<Set<string>> {
  const components = join(ROOT, 'node_modules', 'daisyui', 'components');
  const sheets = [
    join(ROOT, 'views', 'assets', 'main.css'),
    ...(await readdir(components))
      .filter((file) => file.endsWith('.css'))
      .map((file) => join(components, file)),
  ];
  const names = new Set<string>();
  for (const sheet of sheets) {
    for (const name of designClassesOf(await readFile(sheet, 'utf8'))) {
      names.add(name);
    }
  }
  return names;
}

interface Measured extends Pick<PageA11y, 'counts' | 'kinds'> {
  offenders: Offender[];
  /** What changed during each axe run discarded before the still one (runWhileStill). */
  reruns: string[][];
}

/** One axe rule's violation as the page reports it: no element leaves the page. */
interface InPageViolation {
  id: string;
  impact: string;
  help: string;
  nodes: { selector: string; element: ElementDescriptor; detail: string }[];
}

/**
 * axe's run, the text-entry fields iOS zooms into and the tap targets, each
 * violating element described for kindOf, all in one call in the page.
 * axe hands back the element it judged (`elementRef`), so nothing is looked
 * up again after it, and a run the page changed during is rerun
 * (runWhileStill, injected before): a fragment swapped in meanwhile cannot
 * make a node stale or name another element (#1207). Runs in the browser (serialized by
 * page.evaluate, axe injected before it): no closures, no imports.
 */
export async function measureInPage(limits: {
  fontMin: number;
  targetMin: number;
  attempts: number;
}): Promise<{
  axeVersion: string;
  reruns: string[][];
  violations: InPageViolation[];
  fields: { selector: string; element: ElementDescriptor; px: number }[];
  targets: {
    selector: string;
    element: ElementDescriptor;
    width: number;
    height: number;
    lands: string;
  }[];
}> {
  const describe = (el: Element): string => {
    const id = el.id ? `#${el.id}` : '';
    const name = el.getAttribute('name');
    const label =
      el.getAttribute('aria-label') ??
      (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}${id}${name ? `[name=${name}]` : ''}${label ? ` "${label}"` : ''}`;
  };
  // The nearest region (RegionDescriptor): a named section or a form tells
  // two offenders of one shape apart; a landmark is named by its classes.
  const REGION =
    'form[action], section[id], section[aria-labelledby], header, nav, aside, footer, dialog, main';
  const element = (el: Element): ElementDescriptor => {
    const tag = el.tagName.toLowerCase();
    const region = el.parentElement?.closest(REGION) ?? document.body;
    return {
      tag,
      role: el.getAttribute('role'),
      type:
        tag === 'input' || tag === 'button' ? el.getAttribute('type') : null,
      href: tag === 'a' ? el.getAttribute('href') : null,
      classes: [...el.classList],
      region: {
        tag: region.tagName.toLowerCase(),
        name: region.id || region.getAttribute('aria-labelledby'),
        action:
          region.tagName === 'FORM' ? region.getAttribute('action') : null,
        classes: [...region.classList],
      },
    };
  };
  const injected = window as unknown as {
    axe: typeof Axe;
    closetRunWhileStill: typeof runWhileStill;
    closetTapMisses: typeof tapMisses;
  };
  // Every change to the document while axe runs (runWhileStill), by its
  // target: a node axe judged may have been swapped out since.
  const watch = () => {
    const seen: MutationRecord[] = [];
    const observer = new MutationObserver((records) => seen.push(...records));
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
    });
    const nameOf = (node: Node) => {
      if (!(node instanceof Element)) return node.nodeName;
      const id = node.id ? `#${node.id}` : '';
      return `${node.tagName.toLowerCase()}${id}`;
    };
    return {
      changes: () =>
        [...seen, ...observer.takeRecords()].map((record) =>
          record.type === 'attributes'
            ? `${record.attributeName ?? 'an attribute'} of ${nameOf(record.target)}`
            : `the children of ${nameOf(record.target)}`,
        ),
      stop: () => observer.disconnect(),
    };
  };
  // Described inside the watched run, so a change before the description
  // discards it too.
  const runAxe = async () => {
    const results = await injected.axe.run(document, { elementRef: true });
    return {
      version: results.testEngine.version,
      violations: results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact ?? 'minor',
        help: violation.help,
        nodes: violation.nodes.flatMap((node) => {
          if (!node.element) return [];
          if (!node.element.isConnected) {
            throw new Error(
              `axe's ${violation.id} node ${node.target.join(' ')} is detached`,
            );
          }
          return [
            {
              selector: node.target.join(' '),
              element: element(node.element),
              detail: node.failureSummary ?? '',
            },
          ];
        }),
      })),
    };
  };
  // The run freezes htmx instead of filtering its bookkeeping: `htmx-request`
  // dims a link (main.css) and shows the spinner (`.htmx-indicator`), which
  // changes what axe judges. A cancelled beforeRequest (htmx 2 stops before it
  // adds the indicator classes) keeps polls and `load` triggers from starting
  // one; requests already in flight finished in measurePage's wait. The
  // observer stays the backstop for non-htmx changes.
  const freezeHtmx = (evt: Event) => evt.preventDefault();
  document.addEventListener('htmx:beforeRequest', freezeHtmx, true);
  let still: Awaited<
    ReturnType<typeof runWhileStill<Awaited<ReturnType<typeof runAxe>>>>
  >;
  try {
    still = await injected.closetRunWhileStill(watch, runAxe, limits.attempts);
  } finally {
    document.removeEventListener('htmx:beforeRequest', freezeHtmx, true);
  }
  const { result: results, discarded } = still;
  const { violations } = results;
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
      element: element(el),
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
  const candidates = [
    ...document.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, ' +
        '[role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], ' +
        '[role="switch"], [role="menuitem"], [role="option"]',
    ),
  ].filter((el) => {
    if (el.closest('[inert]') || el.matches(':disabled')) return false;
    if (inline(el)) return false;
    // A control is tapped through its label too: a visually hidden radio
    // behind a chip is shown as the chip.
    const labels =
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
        ? [...(el.labels ?? [])]
        : [];
    return [el, ...labels].some((part) => shown(part));
  });
  // Hit tested, not measured (tapMisses): the theme's hit areas count, and
  // a neighbour's painted over them counts against.
  const misses = injected.closetTapMisses(candidates, limits.targetMin);
  const targets = candidates.flatMap((el, i) => {
    const miss = misses[i];
    if (!miss) return [];
    const lands = miss.hit
      ? [describe(miss.hit), ...miss.hit.classList].join('.')
      : 'nothing';
    return [
      {
        selector: describe(el),
        element: element(el),
        width: miss.width,
        height: miss.height,
        lands: `(${miss.dx}, ${miss.dy}) from its centre lands on ${lands}`,
      },
    ];
  });
  return {
    axeVersion: results.version,
    reruns: discarded,
    violations,
    fields,
    targets,
  };
}

function cookieValue(actor: Actor): string {
  return actor.cookie.slice(actor.cookie.indexOf('=') + 1);
}

/**
 * Puts what measureInPage reads into the page: axe, and the two functions
 * that are self-contained by contract (their docs), so their source runs
 * there. Its own spec (a11y.spec.ts) loads the same way.
 */
export async function injectMeasurers(
  page: Page,
  axeSource: string,
): Promise<void> {
  await page.evaluate(axeSource);
  await page.evaluate(`window.closetRunWhileStill = ${String(runWhileStill)}`);
  await page.evaluate(`window.closetTapMisses = ${String(tapMisses)}`);
}

/** measureInPage's limits for the audit: its tolerances applied to the rules'. */
export const MEASURE_LIMITS = {
  fontMin: FIELD_FONT_MIN_PX,
  targetMin: TARGET_MIN_PX - TARGET_TOLERANCE_PX,
  attempts: STILL_RUN_ATTEMPTS,
} as const;

async function measurePage(page: Page, found: Found): Promise<Measured> {
  // htmx's swaps in flight settle before the run reads the page.
  await page.waitForFunction(() => !document.querySelector('.htmx-request'));
  await injectMeasurers(page, found.axeSource);
  const measured = await page.evaluate(measureInPage, MEASURE_LIMITS);
  found.axeVersion = measured.axeVersion;
  const { rules, design } = found;
  const offenders: Offender[] = [];
  for (const violation of measured.violations) {
    rules[violation.id] = { impact: violation.impact, help: violation.help };
    offenders.push(
      ...violation.nodes.map((node) => ({
        measure: violation.id,
        selector: node.selector,
        kind: kindOf(node.element, design),
        detail: node.detail,
      })),
    );
  }
  offenders.push(
    ...measured.fields.map((field) => ({
      measure: FIELD_FONT,
      selector: field.selector,
      kind: kindOf(field.element, design),
      detail: `${field.px} px`,
    })),
    ...measured.targets.map((target) => ({
      measure: TARGET_SIZE,
      selector: target.selector,
      kind: kindOf(target.element, design),
      detail: `${target.width} × ${target.height} px; ${target.lands}`,
    })),
  );
  return { ...tally(offenders), offenders, reruns: measured.reruns };
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

/** The page steps a browser opens: a plain GET, not an htmx fragment. */
export function browserVisits(
  fixture: Fixture,
  steps: readonly Step[],
): A11yVisit[] {
  return steps.flatMap((step) => {
    const request = step.page?.(fixture);
    if (!request || request.method !== 'GET' || request.htmx) return [];
    const { issue, name, target } = step;
    return [{ id: stepId(step), issue, name, target, request }];
  });
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
  const found: Found = {
    rules: {},
    axeVersion: 'unknown',
    design: await designClasses(),
    axeSource: await readFile(require.resolve('axe-core'), 'utf8'),
  };
  const pages: PageA11y[] = [];
  const failures: string[] = [];
  const detail: Record<string, Offender[]> = {};
  try {
    for (const step of visits) {
      const label = `#${step.issue} ${step.name} (${step.target})`;
      try {
        const { counts, kinds, offenders, reruns } = await visit(
          browser,
          origin,
          fixture,
          step,
          found,
        );
        const { id, issue, name, target } = step;
        pages.push({ id, issue, name, target, counts, kinds });
        detail[step.id] = offenders;
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        console.log(`${label}: ${total} accessibility violation(s)`);
        reruns.forEach((changes) =>
          console.log(
            `${label}: axe rerun, the page changed: ${changes.slice(0, 5).join('; ')}`,
          ),
        );
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
