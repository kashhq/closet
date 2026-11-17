import { describe, expect, it } from 'vitest';
import { renderToString } from '../render';
import { SnapStrip, snapItem } from './snap-strip';

// SnapStrip's desktop modes (#1065, StripDesktop): a choice keeps its strip
// at every width, and only a strip that is not one may browse from lg.

describe('SnapStrip desktop modes', () => {
  it('renders a choice only as a strip: no other mode type-checks', async () => {
    const html = await renderToString(
      <SnapStrip name="garmentId" size="regular" label="Tops">
        <div {...snapItem({ value: '1', selected: true, size: 'regular' })} />
      </SnapStrip>,
    );
    expect(html).toContain('role="listbox"');
    expect(html).not.toContain('data-snap-desktop');
    expect(html).not.toMatch(/lg:(grid|snap-none|before:hidden|snap-start)/);

    const refused = (
      // @ts-expect-error a listbox strip is a choice: it cannot browse
      <SnapStrip size="regular" label="Tops" desktop="grid" />
    );
    const refusedExplicit = (
      // @ts-expect-error nor with `listbox` said out loud
      <SnapStrip size="regular" label="Tops" listbox desktop="row" />
    );
    // @ts-expect-error a choice's item cannot leave its strip either
    const refusedItem = snapItem({
      value: '1',
      selected: false,
      size: 'regular',
      desktop: 'grid',
    });
    expect([refused, refusedExplicit, refusedItem]).toHaveLength(3);
  });

  it('makes a strip that is not a choice name its mode', () => {
    // @ts-expect-error `listbox={false}` must say what it is from lg
    const unnamed = <SnapStrip size="page" label="Ideas" listbox={false} />;
    expect(unnamed).toBeDefined();
  });

  it('lays a grid out on IDEA_GRID from lg, without spacers or step buttons', async () => {
    const html = await renderToString(
      <SnapStrip size="peek" label="Ideas" listbox={false} desktop="grid">
        <article
          {...snapItem({
            value: '1,2',
            selected: true,
            size: 'peek',
            listbox: false,
            desktop: 'grid',
          })}
        />
      </SnapStrip>,
    );
    expect(html).toContain('role="group"');
    expect(html).toContain('data-snap-desktop="grid"');
    expect(html).toContain(
      'lg:grid-cols-[repeat(auto-fill,minmax(var(--tile-idea),1fr))]',
    );
    expect(html).toContain('lg:before:hidden lg:after:hidden');
    expect(html).toContain('lg:[&amp;&gt;[data-snap-step]]:hidden');
    // The phone's card, and no fixed desktop width or desktop spacers.
    expect(html).toContain('w-[85%] lg:w-auto');
    expect(html).not.toContain('lg:w-72');
    expect(html).not.toContain('lg:before:w-');
  });

  it("starts a row at its edge with the size's card width", async () => {
    const html = await renderToString(
      <SnapStrip size="pair" label="Best" listbox={false} desktop="row">
        <article
          {...snapItem({
            value: '1',
            selected: true,
            size: 'pair',
            listbox: false,
            desktop: 'row',
          })}
        />
      </SnapStrip>,
    );
    expect(html).toContain('data-snap-desktop="row"');
    expect(html).toContain('w-11/12 lg:w-72 lg:snap-start');
    expect(html).toContain('lg:before:hidden lg:after:hidden');
    expect(html).not.toContain('lg:before:w-');
    expect(html).not.toContain('lg:grid');
  });
});
