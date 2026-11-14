import { QUANTITY_MAX } from '../../wardrobe/availability';
import { PostForm } from '../form';
import { t } from '../i18n';
import { GarmentThumb } from '../layout/parts';
import { categoryLabel } from './garment';
import type { ClosetLookalike } from './lookalikes';
import { idListValue } from './urls';
import { garmentUrl, wardrobeUrl } from './urls';

/**
 * The garment form's duplicate check (#20; lookalikes.ts): the closet
 * garments the one being added looks like, each with "Add a copy", and
 * "Not the same". A suggestion beside Save, never in its way.
 *
 * The region element is rendered once with the form and never swapped: it
 * listens for any change in the form and asks GET LOOKALIKES_PATH for its
 * contents (LookalikesContent), sending only the fields that decide a
 * match (LOOKALIKE_PARAMS). A read, so not an autosave; its own indicator
 * keeps the app bar's spinner still.
 *
 * "Add a copy" posts nothing from the garment form: its buttons belong to
 * LookalikeCopyForm, rendered after it (`form=`), each naming its match's
 * POST /wardrobe/:id/copies (formaction). They must never be the garment
 * form's own: a submit button there comes before Save in tree order, so it
 * would be the form's default button and Enter in the name field would add
 * a copy instead of saving.
 */

const LOOKALIKES_ID = 'garment-lookalikes';
const LOOKALIKES_PATH = '/wardrobe/lookalikes';
const COPY_FORM_ID = 'garment-lookalike-copy';

/** The form's fields a refresh sends: what decides a match, and the dismissed list. */
const LOOKALIKE_PARAMS = 'category,type,color,brand,lookalikesDismissed';

export interface LookalikesPanel {
  matches: ClosetLookalike[];
  dismissed: readonly number[];
  /**
   * The shared wardrobe the garment lands in (undefined: the requester's
   * own, a clone's always): where the refresh reads and a copy is added.
   */
  viewOwner: number | undefined;
}

export function LookalikesRegion({ panel }: { panel: LookalikesPanel }) {
  return (
    <div
      id={LOOKALIKES_ID}
      aria-live="polite"
      hx-get={wardrobeUrl(panel.viewOwner, {}, LOOKALIKES_PATH)}
      hx-trigger="change from:closest form"
      hx-include="closest form"
      hx-params={LOOKALIKE_PARAMS}
      hx-target="this"
      hx-swap="innerHTML"
      hx-sync="this:replace"
      hx-indicator="this"
    >
      <LookalikesContent panel={panel} />
    </div>
  );
}

/** The region's contents: GET LOOKALIKES_PATH answers this. */
export function LookalikesContent({ panel }: { panel: LookalikesPanel }) {
  const { matches, dismissed, viewOwner } = panel;
  return (
    <>
      <input
        type="hidden"
        name="lookalikesDismissed"
        value={idListValue(dismissed)}
      />
      {matches.length > 0 && (
        <div
          role="note"
          class="alert alert-info alert-soft flex flex-col items-stretch gap-2 text-sm"
          data-lookalikes=""
        >
          <p class="font-medium">{t('lookalikes.TITLE')}</p>
          <ul class="flex flex-col gap-2">
            {matches.map((match) => (
              <LookalikeRow match={match} viewOwner={viewOwner} />
            ))}
          </ul>
          <p class="text-xs">{t('lookalikes.HINT')}</p>
          <button
            type="button"
            class="btn btn-ghost btn-sm self-start"
            hx-get={wardrobeUrl(viewOwner, {}, LOOKALIKES_PATH)}
            hx-include="closest form"
            hx-params={LOOKALIKE_PARAMS}
            hx-vals={JSON.stringify({
              lookalikesDismissed: idListValue([
                ...dismissed,
                ...matches.map((match) => match.id),
              ]),
            })}
            hx-target={`#${LOOKALIKES_ID}`}
            hx-swap="innerHTML"
            hx-indicator={`#${LOOKALIKES_ID}`}
            data-lookalikes-dismiss=""
          >
            {t('lookalikes.NOT_THE_SAME')}
          </button>
        </div>
      )}
    </>
  );
}

function LookalikeRow(props: {
  match: ClosetLookalike;
  viewOwner: number | undefined;
}) {
  const { match, viewOwner } = props;
  const name = match.name ?? categoryLabel(match.category);
  return (
    <li class="flex items-center gap-3" data-lookalike={String(match.id)}>
      <GarmentThumb garment={match} class="rounded-box shrink-0" />
      <div class="flex-1 min-w-0">
        <p class="font-medium truncate">{name}</p>
        {match.quantity > 1 && (
          <p class="text-xs">
            {t('lookalikes.COPIES', { count: match.quantity })}
          </p>
        )}
      </div>
      {match.quantity < QUANTITY_MAX && (
        <button
          type="submit"
          form={COPY_FORM_ID}
          formaction={garmentUrl(match.id, viewOwner, '/copies')}
          class="btn btn-sm btn-primary shrink-0"
          aria-label={t('lookalikes.ADD_COPY_OF', { name })}
        >
          {t('lookalikes.ADD_COPY')}
        </button>
      )}
    </li>
  );
}

/**
 * The form "Add a copy" submits (see above): empty, after the garment form
 * (forms cannot nest). Every button names its own route (formaction), so
 * the form's own action, the check's read path, is never posted to.
 */
export function LookalikeCopyForm() {
  return <PostForm id={COPY_FORM_ID} action={LOOKALIKES_PATH} />;
}
