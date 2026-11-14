import type { Child } from 'hono/jsx';
import { PostForm } from '../auth/form';
import { t } from '../i18n';
import { PageSentinel } from '../page-sentinel';
import { collagePieces, OutfitCollage } from './collage';
import { type OutfitList, OutfitListTabs } from './outfit-list';
import type { GarmentOutfit } from './queries';
import { buyFirstNote } from './to-buy';

/**
 * One saved outfit as a submit button of a picking form (its id is the
 * submitter's value, `outfitId`): the calendar's plan page and a trip's add
 * page (#10). The whole outfit as its `row` collage over the name, as a
 * trip's own rows show it (#360). Disabled, saying why, when picking it
 * would change nothing (`note`: already on the day, already on the trip) or
 * be refused: an incomplete outfit (#335) is neither planned nor packed
 * until its pieces are bought. Disabled reads through the card (flat, on
 * the plinth colour) and its dimmed picture; the name and the reason stay
 * at full strength (text is never dimmed: Conventions). The picture is
 * hidden from assistive tech, as the old thumbs' empty alts were: the
 * button's name is the outfit's, and the note says what is to buy.
 */
function SavedOutfitButton(props: {
  outfit: GarmentOutfit;
  note: string | undefined;
}) {
  const { outfit } = props;
  const note = props.note ?? buyFirstNote(outfit.garments);
  return (
    <button
      type="submit"
      name="outfitId"
      value={String(outfit.id)}
      class="group card bg-base-100 shadow-sm gap-2 p-2 text-left disabled:bg-base-200 disabled:shadow-none disabled:cursor-not-allowed"
      disabled={note !== undefined}
    >
      <span class="flex min-w-0 group-disabled:opacity-50" aria-hidden="true">
        <OutfitCollage
          garments={collagePieces(outfit.garments, { warn: false })}
          size="row"
        />
      </span>
      <span class="flex flex-col min-w-0">
        <span class="font-medium truncate">
          {outfit.name || t('UNTITLED_OUTFIT')}
        </span>
        {note && <span class="text-xs text-muted">{note}</span>}
      </span>
    </button>
  );
}

/**
 * One page of a picker's SavedOutfitButtons and, when there are more
 * (`more`: the next page's address, #660), the sentinel that fetches it.
 * The pickers' next-page routes (GET /calendar/plan/more, GET
 * /trips/:id/outfits/new/more) answer with this alone, so the page lands
 * inside the same form.
 */
export function SavedOutfitButtons(props: {
  outfits: GarmentOutfit[];
  noteOf: (outfit: GarmentOutfit) => string | undefined;
  more: string | undefined;
}) {
  return (
    <>
      {props.outfits.map((outfit) => (
        <SavedOutfitButton outfit={outfit} note={props.noteOf(outfit)} />
      ))}
      {props.more !== undefined && (
        <PageSentinel
          as="div"
          class="flex justify-center py-4"
          href={props.more}
          trigger="revealed"
          marker="picker"
          label={t('outfits.LOADING_MORE')}
        />
      )}
    </>
  );
}

/**
 * The pickers' "Saved" section (the calendar's plan page, a trip's add
 * page): the two lists' tabs (#659: `list` is the one shown, `href` the
 * page's address without it), the first page of the owner's outfits of
 * that list as SavedOutfitButtons of one native PostForm to `action`,
 * which carries the page's hidden fields (`children`), or the line saying
 * there are none.
 */
export function SavedOutfitPicker(props: {
  heading: Child;
  action: string;
  list: OutfitList;
  href: string;
  outfits: GarmentOutfit[];
  noteOf: (outfit: GarmentOutfit) => string | undefined;
  /** The next page's address (SavedOutfitButtons' `more`); none on the last. */
  more: string | undefined;
  children: Child;
}) {
  return (
    <section class="flex flex-col gap-2">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">
        {props.heading}
      </h2>
      <OutfitListTabs list={props.list} href={props.href} />
      {props.outfits.length > 0 ? (
        <PostForm action={props.action} class="flex flex-col gap-2">
          {props.children}
          <SavedOutfitButtons
            outfits={props.outfits}
            noteOf={props.noteOf}
            more={props.more}
          />
        </PostForm>
      ) : (
        <p class="text-sm text-muted">
          {props.list === 'kept'
            ? t('CALENDAR_PLAN_NO_OUTFITS')
            : t('outfits.NO_ONE_OFFS')}
        </p>
      )}
    </section>
  );
}
