import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { escapeHtml, jsonForScript } from './html';
import { t, tHtml } from './i18n';
import { renderToString } from './render';

/**
 * The guarantees the web layer's views rely on (AGENTS.md, Web layer):
 * hono/jsx escapes every text child and attribute value, async components
 * render, and markup only passes through `dangerouslySetInnerHTML`.
 */

const EVIL = `"><script>alert('x')</script>&`;
const ESCAPED =
  '&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;';

function Card(props: { name: string }) {
  return (
    <div title={props.name} data-name={props.name}>
      {props.name}
    </div>
  );
}

async function Slow(props: { name: string }) {
  await sleep(1);
  return <span>{props.name}</span>;
}

describe('hono/jsx', () => {
  it('escapes text children and attribute values', async () => {
    const html = await renderToString(<Card name={EVIL} />);
    expect(html).toBe(
      `<div title="${ESCAPED}" data-name="${ESCAPED}">${ESCAPED}</div>`,
    );
    expect(html).not.toContain('<script>');
  });

  it('escapes JSON in attributes (hx-vals) and text inside <script>', async () => {
    const html = await renderToString(
      <>
        <button hx-vals={JSON.stringify({ name: EVIL })}></button>
        <script>{EVIL}</script>
      </>,
    );
    expect(html).not.toContain('<script>alert');
    expect(html).toContain(`<script>${ESCAPED}</script>`);
  });

  it('renders async components, escaped like the rest', async () => {
    const html = await renderToString(
      <p>
        <Slow name={EVIL} />
      </p>,
    );
    expect(html).toBe(`<p><span>${ESCAPED}</span></p>`);
  });

  it('passes markup through dangerouslySetInnerHTML only', async () => {
    const html = await renderToString(
      <p dangerouslySetInnerHTML={{ __html: '<a href="/x">x</a>' }} />,
    );
    expect(html).toBe('<p><a href="/x">x</a></p>');
  });
});

describe('t', () => {
  it('interpolates parameters as plain text (JSX escapes them)', async () => {
    expect(t('ABOUT_HEADING', { appName: EVIL })).toBe(`About ${EVIL}`);
    expect(
      await renderToString(<h1>{t('ABOUT_HEADING', { appName: EVIL })}</h1>),
    ).toBe(`<h1>About ${ESCAPED}</h1>`);
  });

  it('reads nested keys', () => {
    expect(t('validation.IS_EMAIL')).toBe(
      'Enter an email address, like name@example.com',
    );
  });

  it('throws on a missing parameter instead of rendering the placeholder', () => {
    // @ts-expect-error the type requires it too (#1100); this is the runtime's guard
    expect(() => t('ABOUT_HEADING')).toThrow(/missing parameter \{appName\}/);
  });
});

describe('tHtml', () => {
  it('keeps the trusted markup and escapes the parameters', () => {
    const html = tHtml('ABOUT_OPEN_SOURCE_DESC', { appName: EVIL });
    expect(html.startsWith(`${ESCAPED} is free software`)).toBe(true);
    expect(html).toContain('<a href="https://github.com/kashhq/closet"');
    expect(html).not.toContain('<script>');
  });
});

describe('string helpers', () => {
  it('escapeHtml escapes what hono/jsx escapes', () => {
    expect(escapeHtml(EVIL)).toBe(ESCAPED);
  });

  it('jsonForScript cannot close the script element', () => {
    const json = jsonForScript({ name: '</script><script>alert(1)' });
    expect(json).not.toContain('</script>');
    expect(JSON.parse(json)).toEqual({ name: '</script><script>alert(1)' });
  });
});
