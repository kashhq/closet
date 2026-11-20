/**
 * Where a fingertip on a control does not reach it: the one definition of a
 * control's tap area, shared by the page audit's `target < 44 px`
 * (scripts/audit/a11y.ts) and the Playwright scenarios' expectTouchTargets
 * (touch-targets.ts). Each control's tap is a disc `min` px across (a
 * fingertip is round, and a square's corners would fail every round 44 px
 * button), centred on the control's tap box (tapBox: it, its labels and its
 * positioned pseudo-elements) and kept inside the viewport; the disc is the control's when the browser's own hit
 * test at its centre and at eight points on its rim lands on the control, a
 * descendant, or one of its labels.
 *
 * Hit testing, not geometry, so it counts what a tap counts: the theme's
 * transparent ::after and ::before hit areas (views/assets/main.css, Touch
 * hit areas), a label's box, and against them an ancestor's overflow that
 * clips the area, a neighbour's area painted over it and fixed chrome.
 *
 * Each control is scrolled to the middle of the viewport (window and nested
 * scrollers) for its test, and every scroll position is put back before it
 * returns. All of it runs synchronously, so no scroll event or
 * IntersectionObserver ever sees a moved page: a paging sentinel
 * (`revealed`, `intersect`) does not fire.
 *
 * Runs in the page (serialized by its callers: injected by its source, or
 * passed to evaluate), so it must reference nothing outside itself.
 */
export interface TapMiss {
  /** The control's tap box (tapBox), in CSS px. */
  width: number;
  height: number;
  /** The first point of the disc that missed, from its centre, in CSS px. */
  dx: number;
  dy: number;
  /** What a tap there lands on instead: null for nothing (off the page). */
  hit: Element | null;
}

export function tapMisses(
  controls: readonly Element[],
  min: number,
): (TapMiss | null)[] {
  // Every scroller's position, restored at the end: scrollIntoView moves the
  // window and each scrolling ancestor.
  const scrollers = [
    document.scrollingElement ?? document.documentElement,
    ...[...document.querySelectorAll('*')].filter(
      (el) =>
        el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth,
    ),
  ].map((el) => ({ el, left: el.scrollLeft, top: el.scrollTop }));
  // Chromium hit tests whole pixels: a fractional point is the next pixel
  // row or column (43.25 lands on a box starting at 44). So each point is
  // that of a whole pixel, rounded toward the centre, and the rim sits half
  // a pixel in, or a box exactly `min` across would lose its edge pixel: a
  // disc within a pixel of `min` passes.
  const radius = min / 2 - 0.5;
  const towardCentre = (at: number, offset: number): number => {
    if (offset > 0) return Math.floor(at);
    if (offset < 0) return Math.ceil(at);
    return Math.round(at);
  };
  const diagonal = radius * Math.SQRT1_2;
  const points: readonly (readonly [number, number])[] = [
    [0, 0],
    [-radius, 0],
    [radius, 0],
    [0, -radius],
    [0, radius],
    [-diagonal, -diagonal],
    [diagonal, -diagonal],
    [-diagonal, diagonal],
    [diagonal, diagonal],
  ];
  type Box = { left: number; top: number; right: number; bottom: number };
  // A positioned pseudo-element's box: its resolved insets against its
  // containing block, the element when it is positioned, else its
  // offsetParent. The element's own overflow clips the box only when the
  // element is that block: a `truncate` btn-sm loses its hit area, a static
  // `truncate` button stretched over its tile (the Saved tab's) does not.
  const pseudoBox = (el: Element, which: '::before' | '::after') => {
    const style = getComputedStyle(el, which);
    if (style.content === 'none' || style.display === 'none') return null;
    if (style.position !== 'absolute' && style.position !== 'fixed') {
      return null;
    }
    const own = getComputedStyle(el);
    const positioned = own.position !== 'static';
    if (positioned && own.overflow !== 'visible') return null;
    const block = positioned
      ? el
      : ((el as HTMLElement).offsetParent ?? document.documentElement);
    const outer = block.getBoundingClientRect();
    const left = outer.left + block.clientLeft;
    const top = outer.top + block.clientTop;
    // An inline link has no client size: its box is the block.
    const width = block.clientWidth || outer.width;
    const height = block.clientHeight || outer.height;
    return {
      left: left + parseFloat(style.left),
      top: top + parseFloat(style.top),
      right: left + width - parseFloat(style.right),
      bottom: top + height - parseFloat(style.bottom),
    };
  };
  // Where the control is drawn and stretched: the larger of it and its
  // labels (a hidden radio behind its chip is the chip), unioned with its
  // positioned pseudo-elements (the theme's hit areas, a stretched link's
  // ::after over its card or cell). The disc is centred on it.
  const tapBox = (el: Element): Box => {
    const labels =
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
        ? [...(el.labels ?? [])]
        : [];
    const drawn = [el, ...labels]
      .map((part) => part.getBoundingClientRect())
      .reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    return (['::before', '::after'] as const)
      .flatMap((which) => pseudoBox(el, which) ?? [])
      .reduce<Box>(
        (a, b) => ({
          left: Math.min(a.left, b.left),
          top: Math.min(a.top, b.top),
          right: Math.max(a.right, b.right),
          bottom: Math.max(a.bottom, b.bottom),
        }),
        drawn,
      );
  };
  const owns = (el: Element, hit: Element | null): boolean => {
    if (!hit) return false;
    if (el.contains(hit)) return true;
    const labels =
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
        ? [...(el.labels ?? [])]
        : [];
    return labels.some((label) => label.contains(hit));
  };
  try {
    return controls.map((el) => {
      // The control's box decides where it lands: a hidden input behind its
      // chip label scrolls the chip into view.
      el.scrollIntoView({
        block: 'center',
        inline: 'center',
        behavior: 'instant',
      });
      const box = tapBox(el);
      const width = box.right - box.left;
      const height = box.bottom - box.top;
      const cx = Math.min(
        Math.max(box.left + width / 2, min / 2),
        innerWidth - min / 2,
      );
      const cy = Math.min(
        Math.max(box.top + height / 2, min / 2),
        innerHeight - min / 2,
      );
      for (const [dx, dy] of points) {
        const hit = document.elementFromPoint(
          towardCentre(cx + dx, dx),
          towardCentre(cy + dy, dy),
        );
        if (!owns(el, hit)) {
          return {
            width: Math.round(width * 10) / 10,
            height: Math.round(height * 10) / 10,
            dx: Math.round(dx),
            dy: Math.round(dy),
            hit,
          };
        }
      }
      return null;
    });
  } finally {
    for (const { el, left, top } of scrollers) {
      el.scrollTo({ left, top, behavior: 'instant' });
    }
  }
}
