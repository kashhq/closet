import { CONDITIONS } from '../../wardrobe/properties';
import { AutosaveForm } from '../autosave';
import { t } from '../i18n';
import { valueLabel } from './labels';
import type { GarmentDetail } from './queries';
import { garmentUrl } from './urls';
import { CARE_NOTE_MAX } from './garment-input';

const SECTION_ID = 'garment-condition';

/**
 * The garment page's condition (src/web/wardrobe/garment-page.tsx). For the
 * owner and a MANAGE grantee: a chip per condition and, with a problem, what
 * is wrong, an `AutosaveForm` posted on every change (a chip, or the note on
 * blur or Enter) to POST /wardrobe/:id/condition, which saves at once and
 * answers the status line; the form's own action is the no-script path. The
 * note is always in the form and hidden by CSS while "Good" is checked, so
 * it appears the moment a problem is tapped, with no answer to wait for.
 * For a viewer: the condition and its note, only when it is not good. Never
 * part of availability: a garment that needs repair is still in the closet.
 */
export function GarmentCondition(props: {
  garment: Pick<GarmentDetail, 'id' | 'condition' | 'conditionNote'>;
  viewOwner: number | undefined;
  canEdit: boolean;
}) {
  const { garment, viewOwner } = props;
  if (!props.canEdit) {
    if (garment.condition === 'good')
      return <section id={SECTION_ID}></section>;
    return (
      <section id={SECTION_ID} class="flex flex-col gap-1">
        <span class="badge badge-warning">
          {valueLabel('condition', garment.condition)}
        </span>
        {garment.conditionNote && (
          <p class="text-sm text-base-content/70">{garment.conditionNote}</p>
        )}
      </section>
    );
  }
  return (
    <section id={SECTION_ID}>
      <h2 class="text-sm text-muted mb-2">{t('CONDITION')}</h2>
      <AutosaveForm
        action={garmentUrl(garment.id, viewOwner, '/condition')}
        native
        class="group flex flex-col gap-2"
      >
        <div class="chip-row">
          {CONDITIONS.map((condition) => (
            <input
              type="radio"
              name="condition"
              value={condition}
              class={`btn btn-sm rounded-full ${condition === 'good' ? '' : 'checked:btn-warning'}`}
              aria-label={valueLabel('condition', condition)}
              checked={condition === garment.condition}
              data-no-note={condition === 'good' ? '' : undefined}
            />
          ))}
        </div>
        {/* Posted with "Good" too; the server keeps a note only with a
            problem (readCondition). */}
        <input
          type="text"
          name="conditionNote"
          value={garment.conditionNote ?? ''}
          maxlength={CARE_NOTE_MAX}
          placeholder={t('CONDITION_NOTE_PLACEHOLDER')}
          aria-label={t('CONDITION_NOTE')}
          class="input input-bordered input-sm w-full group-has-[[data-no-note]:checked]:hidden"
        />
      </AutosaveForm>
    </section>
  );
}
