import type { GarmentMarkKind } from '../../wardrobe/marks';
import { joinCopy, type CopyKey, t, type Translated } from '../i18n';

/**
 * Each mark's one look and one string: the badge variant, the dot (its fill,
 * or set-aside's outline, in the badge's token) and its words. A mark
 * reads the same on every surface; a new mark is a row here and in
 * GARMENT_MARKS (src/wardrobe/marks.ts).
 */
const MARKS: Record<
  GarmentMarkKind,
  { badge: string; dot: string; label: CopyKey }
> = {
  'to-buy': { badge: 'badge-accent', dot: 'bg-accent', label: 'mark.TO_BUY' },
  archived: {
    badge: 'badge-neutral',
    dot: 'bg-neutral',
    label: 'mark.ARCHIVED',
  },
  'away:lent': {
    badge: 'badge-warning',
    dot: 'bg-warning',
    label: 'mark.LENT',
  },
  'away:repair': {
    badge: 'badge-warning',
    dot: 'bg-warning',
    label: 'mark.AT_REPAIR',
  },
  'needs-wash': {
    badge: 'badge-info',
    dot: 'bg-info',
    label: 'mark.NEEDS_WASH',
  },
  'set-aside': {
    badge: 'badge-outline',
    dot: 'border border-base-content',
    label: 'mark.SET_ASIDE',
  },
};

/** How many of a multiple's copies wait for a wash: "Wash 2/3" on its tile. */
export interface WashCount {
  dirty: number;
  copies: number;
}

export function markLabel(mark: GarmentMarkKind, wash?: WashCount): Translated {
  if (mark === 'needs-wash' && wash && wash.copies > 1) {
    return t('mark.NEEDS_WASH_COPIES', { ...wash });
  }
  return t(MARKS[mark].label);
}

/**
 * A garment's status mark (`garmentMarks()`, src/wardrobe/marks.ts): the
 * first mark in words, the rest in its accessible name only, so a small
 * tile never stacks badges. `dot` is for a frame too small for words (the
 * collage's thumbs): a dot of the mark's colour, every word for screen
 * readers. `text` puts other words in the first mark's look (the agent's price
 * on a piece to buy). `class` is placement only (position, a responsive
 * size step), never a colour: the look is the mark's. `wash` counts the
 * copies of a multiple in the needs-wash words ("Wash 2/3").
 *
 * Used by the grid tiles, Styling's rows, the garment page, the agent's cards,
 * the collage and the public share page. Nothing when there is no mark.
 */
export function GarmentMark(props: {
  marks: readonly GarmentMarkKind[];
  dot?: boolean;
  text?: string;
  wash?: WashCount;
  class?: string;
}) {
  const [first, ...rest] = props.marks;
  if (first === undefined) return null;
  const style = MARKS[first];
  const more = rest.length > 0 && (
    <span class="sr-only">
      {t('mark.MORE', {
        marks: joinCopy(
          rest.map((mark) => markLabel(mark, props.wash)),
          ', ',
        ),
      })}
    </span>
  );
  if (props.dot) {
    return (
      <span
        class={classes(
          'inline-block size-2 rounded-full',
          style.dot,
          props.class,
        )}
        data-mark={first}
      >
        <span class="sr-only">{markLabel(first, props.wash)}</span>
        {more}
      </span>
    );
  }
  return (
    <span
      class={classes(
        'badge badge-xs whitespace-nowrap',
        style.badge,
        props.class,
      )}
      data-mark={first}
    >
      {props.text ?? markLabel(first, props.wash)}
      {more}
    </span>
  );
}

const classes = (...parts: (string | undefined)[]) =>
  parts.filter(Boolean).join(' ');
