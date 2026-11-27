import type { Child, JSX } from 'hono/jsx';

/**
 * Every card of the app (#727; the two variants are documented in
 * views/assets/AGENTS.md, Cards). The theme is flat, so neither has a shadow
 * (`shadow-` is refused outside dropdowns, toasts and sheets by ESLint).
 *
 * - `content`: a hairline `border-base-300` on `base-100`, for what a page
 *   shows: Today's rows, Profile's sections, the agent cards.
 * - `inset`: a `base-200` fill, for a form panel set into a page. It is also
 *   the plinth's colour, so never put a cutout straight on it (the garment
 *   would lose its plinth): a cutout sits on a `content` card.
 *
 * `bodyClass` adds daisyUI's `card-body` inside (padding and gap are the
 * caller's: `p-3 gap-2`); without it the children sit in the card itself.
 */
const VARIANT = {
  content: 'border border-base-300 bg-base-100',
  inset: 'bg-base-200',
} as const;

export type CardVariant = keyof typeof VARIANT;

/** The classes alone, for an element `Card` cannot be (a `PostForm`). */
export function cardClass(variant: CardVariant, extra?: string): string {
  return ['card', VARIANT[variant], extra].filter(Boolean).join(' ');
}

type CardProps = Omit<JSX.IntrinsicElements['div'], 'children' | 'class'> & {
  variant: CardVariant;
  /** The element: a list item, an article or a link as the page needs. */
  as?: 'div' | 'section' | 'article' | 'li' | 'nav' | 'a';
  /** With `as="a"`: the whole card is the link. */
  href?: string;
  class?: string;
  bodyClass?: string;
  children?: Child;
};

export function Card(props: CardProps) {
  const { variant, as, class: extra, bodyClass, children, ...rest } = props;
  const Element = as ?? 'div';
  return (
    <Element class={cardClass(variant, extra)} {...rest}>
      {bodyClass === undefined ? (
        children
      ) : (
        <div class={`card-body ${bodyClass}`}>{children}</div>
      )}
    </Element>
  );
}
