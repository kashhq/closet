import {
  type GarmentMarkKind,
  garmentMarks,
  type MarkedGarment,
  type MarkOptions,
} from '../../wardrobe/marks';
import { inOutfitOrderByCategory } from '../../wardrobe/generator';
import { categoryRole, type GarmentRole } from '../../wardrobe/properties';
import { type SignablePhotoRef, imageUrl } from '../files/image-url';
import { viewerTrigger } from '../files/photo-viewer';
import { GarmentMark, markLabel } from '../layout/garment-mark';
import { GarmentSilhouette } from '../layout/parts';
import { t } from '../i18n';
import { categoryLabel } from '../wardrobe/garment';
import { isPieceToBuy } from './references';

/**
 * An outfit laid out the way clothes lie on a bed: the layer and top side
 * by side, the bottom under them, the shoes at the foot, accessories and
 * bags down the side; cutouts contained (never cropped) on the plinth
 * colour, sized by height so a whole card (collage, name, pick) fits a
 * phone screen above the dock. The redesign's one OutfitCollage
 * (docs/plans/2026-09-26-redesign.md, sections 3 and 5): the gallery's
 * Ideas cards, the outfit page and Today (`card`), the Saved grid
 * (`tile`), the garment page's "In N outfits" and the calendar (`cell`, a
 * `thumb` that grows at lg), and an outfit's row beside its name (`row`:
 * the pickers' SavedOutfitButton and a trip's outfits, #360).
 */

/**
 * Whether a piece opens the photo viewer, and so is in its set (#313): the
 * set's builder and the piece's trigger must agree, or a tap opens the
 * wrong slide.
 */
function inViewerSet(piece: CollagePieceView): boolean {
  return piece.photo !== null;
}

/** What the collage draws of a piece. */
export interface CollagePieceView {
  name: string | null;
  category: string;
  photo: SignablePhotoRef | null;
  /** In garmentMarks' order (collagePieces): the first in words, or a dot. */
  marks?: readonly GarmentMarkKind[];
}

/**
 * How a collage marks an outfit's pieces. Everywhere: `to-buy`, a piece of
 * an incomplete outfit not bought yet (#335). With `warn`, an outfit the
 * owner is about to wear (Today's cards, the calendar's entries not worn
 * yet from today on, the outfit page; #358): also what keeps a piece from
 * being worn, archived and away, and the wash where the read gave it
 * (today's cards only: entriesSql's `washOn`). A warning, never a swap:
 * the mark sends the owner to Change
 * (docs/plans/2026-10-09-structural-refactors.md, Decisions 1). `ownerView`
 * is garmentMarks' gate: away and the wash are the owner's records.
 */
export type PieceMarking = { warn: false } | ({ warn: true } & MarkOptions);

/** An outfit's garments with their marks, for OutfitCollage. */
export function collagePieces<G extends MarkedGarment>(
  garments: readonly G[],
  marking: PieceMarking,
): (G & { marks: GarmentMarkKind[] })[] {
  return garments.map((garment) => ({
    ...garment,
    marks: pieceMarks(garment, marking),
  }));
}

function pieceMarks(
  garment: MarkedGarment,
  marking: PieceMarking,
): GarmentMarkKind[] {
  if (marking.warn) return garmentMarks(garment, marking);
  return isPieceToBuy(garment) ? ['to-buy'] : [];
}

/**
 * A collage link's accessible name: aria-label replaces the link's
 * descendants for screen readers, so the pieces' sr-only mark words would
 * never be announced. "Name: Boots (At repair), Duffel (Lent)"; the bare
 * name when no piece has a mark.
 */
export function outfitLabel(
  name: string,
  pieces: readonly CollagePieceView[],
): string {
  const warnings = pieces
    .filter((piece) => piece.marks?.length)
    .map((piece) =>
      t('mark.PIECE', {
        name: piece.name || categoryLabel(piece.category),
        marks: piece.marks!.map((mark) => markLabel(mark)).join(', '),
      }),
    );
  return warnings.length === 0
    ? name
    : t('mark.OUTFIT_LABEL', { name, warnings: warnings.join(', ') });
}

export interface CollageGarment extends CollagePieceView {
  id: number;
}

const UPPER: readonly GarmentRole[] = ['layer', 'one-piece', 'top'];
const SIDE: readonly GarmentRole[] = ['accessory', 'bag', 'none'];

/**
 * The outfit without its side column (accessories, bags, `none`), for a
 * frame too narrow for it: the calendar month's ~48 px cells. Every garment
 * when the outfit is all side pieces. Shares `SIDE` with the collage's own
 * layout so the two never disagree.
 */
export function bodyOf<G extends CollagePieceView>(
  garments: readonly G[],
): G[] {
  const body = garments.filter((g) => !SIDE.includes(categoryRole(g.category)));
  return body.length > 0 ? body : [...garments];
}

/**
 * Each size's box, garment column and piece heights: `card` for a card a
 * phone screen holds whole, `tile` for the Saved grid's two columns (about
 * 170 px wide at 390 px: a 4:5 frame so the grid's rows line up, the
 * garments centred in it), `thumb` for a strip of small tiles (the garment
 * page's "In N outfits", about 96 px wide).
 */
const SIZES = {
  card: {
    box: 'rounded-box p-3 gap-2',
    column: '',
    upper: 'h-24',
    lower: 'h-28',
    feet: 'h-16',
    side: 'h-12',
  },
  tile: {
    box: 'rounded-box p-2 gap-1.5 aspect-[4/5] lg:p-3 lg:gap-2',
    column: 'justify-center',
    upper: 'h-12 lg:h-16',
    lower: 'h-20 lg:h-24',
    feet: 'h-10 lg:h-14',
    side: 'h-9 lg:h-12',
  },
  thumb: {
    box: 'rounded-field p-1.5 gap-1',
    column: '',
    upper: 'h-8',
    lower: 'h-10',
    feet: 'h-6',
    side: 'h-5',
  },
  // The calendar's: `thumb` on a phone (a month cell about 48 px wide, a week
  // row's 64 px), growing at lg with the month's cell (about 170 px) and the
  // week grid's column (130 to 175 px, #467).
  cell: {
    box: 'rounded-field p-1.5 gap-1 lg:p-3 lg:gap-2',
    column: '',
    upper: 'h-8 lg:h-16',
    lower: 'h-10 lg:h-20',
    feet: 'h-6 lg:h-12',
    side: 'h-5 lg:h-10',
  },
} as const;
export type CollageSize = keyof typeof SIZES | 'row';

export function OutfitCollage(props: {
  garments: readonly CollagePieceView[];
  /** The first card on a page: its images load at once. */
  eager?: boolean;
  size?: CollageSize;
  /**
   * A photo viewer set (PhotoSet) whose id makes each photo a button that
   * opens it (#313). Only where the collage is not itself inside a link or
   * button.
   */
  viewerSet?: string;
  /**
   * The link around the collage already names the outfit (its aria-label or
   * the name beside it), so the photos' alt text would only repeat it.
   */
  decorative?: boolean;
}) {
  const { garments, eager = false } = props;
  const size = props.size ?? 'card';
  if (size === 'row') return <CollageRow garments={garments} eager={eager} />;
  const sizes = SIZES[size];
  const of = (roles: readonly GarmentRole[]) =>
    garments.filter((g) => roles.includes(categoryRole(g.category)));
  const upper = of(UPPER);
  const lower = of(['bottom']);
  const feet = of(['footwear']);
  const side = of(SIDE);
  const piece = (garment: CollagePieceView, height: string) => (
    <CollagePiece
      garment={garment}
      class={height}
      eager={eager}
      viewerSet={props.viewerSet}
      decorative={props.decorative ?? false}
      labelled={size === 'card'}
      words={size !== 'thumb' && size !== 'cell'}
    />
  );
  return (
    <div class={`bg-base-200 flex ${sizes.box}`} data-collage={size}>
      <div
        class={['flex-1 flex flex-col items-center gap-1 min-w-0', sizes.column]
          .filter(Boolean)
          .join(' ')}
      >
        {upper.length > 0 && (
          <div class="flex justify-center gap-1 w-full">
            {upper.map((g) => piece(g, sizes.upper))}
          </div>
        )}
        {lower.map((g) => piece(g, sizes.lower))}
        {feet.length > 0 && (
          <div class="flex justify-center gap-1 w-full">
            {feet.map((g) => piece(g, sizes.feet))}
          </div>
        )}
      </div>
      {side.length > 0 && (
        <div class="flex flex-col justify-center gap-1">
          {side.map((g) => piece(g, sizes.side))}
        </div>
      )}
    </div>
  );
}

/**
 * Every piece in a line, top to toe (the order an outfit's name lists
 * them), at one small fixed size: a picker's or a trip's outfit row, where
 * a column would not fit beside the name and the old first-three thumbs cut
 * the shoes off (#360). Nothing is dropped: past what a phone's row holds
 * (seven pieces at 390 px) the strip scrolls inside itself, never the page.
 * Spans throughout, as it sits inside a submit button (phrasing content).
 * Marks are dots, as on a thumb: the pieces are too small for words.
 */
function CollageRow(props: {
  garments: readonly CollagePieceView[];
  eager: boolean;
}) {
  // Callers wrap it in aria-hidden (its imgs carry alt text, which would
  // pad the button's or link's name); tabindex -1 keeps the scrolling strip
  // from becoming a tab stop inside that hidden subtree (axe aria-hidden-focus).
  return (
    <span
      class="bg-base-200 rounded-field p-1 flex gap-1 w-fit max-w-full overflow-x-auto *:shrink-0"
      data-collage="row"
      tabindex={-1}
    >
      {inOutfitOrderByCategory(props.garments).map((garment) => (
        <CollagePiece
          garment={garment}
          class="h-10"
          eager={props.eager}
          viewerSet={undefined}
          decorative={false}
          labelled={false}
          words={false}
        />
      ))}
    </span>
  );
}

/**
 * A garment of the collage: its thumb, or a hanger (and its name on a
 * card). A marked piece wears its GarmentMark over its foot; a thumb's
 * pieces are too small for words, so there the mark is a dot, saying what
 * it means to screen readers only.
 */
function CollagePiece(props: {
  garment: CollagePieceView;
  class: string;
  eager: boolean;
  viewerSet: string | undefined;
  decorative: boolean;
  labelled: boolean;
  words: boolean;
}) {
  const marks = props.garment.marks ?? [];
  const face = <CollageFace {...props} />;
  if (marks.length === 0) return face;
  return (
    <span class="relative flex justify-center max-w-full min-w-0">
      {face}
      {props.words ? (
        <FootMark marks={marks} />
      ) : (
        <GarmentMark marks={marks} dot class="absolute bottom-0 right-0" />
      )}
    </span>
  );
}

/**
 * A garment's mark in words over a piece's foot (its parent is
 * `relative`): the collage's pieces and the public share page's thumbs.
 */
export function FootMark({ marks }: { marks: readonly GarmentMarkKind[] }) {
  return (
    <GarmentMark
      marks={marks}
      class="absolute bottom-0 left-1/2 -translate-x-1/2"
    />
  );
}

function CollageFace(props: {
  garment: CollagePieceView;
  class: string;
  eager: boolean;
  viewerSet: string | undefined;
  decorative: boolean;
  labelled: boolean;
}) {
  const { garment } = props;
  const viewer =
    props.viewerSet && inViewerSet(garment)
      ? {
          ...viewerTrigger(props.viewerSet, garment.photo!),
          role: 'button',
          tabindex: '0',
        }
      : {};
  return garment.photo ? (
    <img
      src={imageUrl(garment.photo, 'thumb')}
      alt={props.decorative ? '' : (garment.name ?? '')}
      {...viewer}
      data-collage-piece={garment.category}
      class={`${props.class} w-auto min-w-0 max-w-full aspect-square object-contain`}
      width="200"
      height="200"
      loading={props.eager ? 'eager' : 'lazy'}
      decoding="async"
    />
  ) : (
    <span
      data-collage-piece={garment.category}
      class={`${props.class} aspect-square min-w-0 max-w-full rounded-box bg-base-100 flex flex-col items-center justify-center gap-1 text-muted p-1`}
    >
      <GarmentSilhouette
        category={garment.category}
        class={`${props.labelled ? 'size-6' : 'size-4'} max-w-full max-h-full`}
        strokeWidth="1.5"
      />
      {props.labelled && (
        <span class="text-xs text-center line-clamp-2">{garment.name}</span>
      )}
    </span>
  );
}
