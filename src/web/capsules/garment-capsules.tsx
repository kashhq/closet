import { AutosaveForm } from '../autosave';
import { ShownId } from '../checklist';
import { t } from '../i18n';
import { capsuleUrl, garmentUrl } from '../wardrobe/urls';
import type { GarmentCapsule } from './queries';

const SECTION_ID = 'garment-capsules';

/**
 * The garment page's capsules row (src/web/wardrobe/garment-page.tsx):
 * for the owner and a MANAGE grantee a toggle per capsule of the wardrobe,
 * an `AutosaveForm` posted on every change to POST /wardrobe/:id/capsules,
 * which saves at once and answers only the status line: the toggles are
 * what the person set, and nothing else in the section changes with them.
 * For a viewer the capsules the garment is in, as links. Nothing without
 * capsules (or, for a viewer, without memberships). Not a native form: its
 * only values are the chips, so nothing a person does can be refused with
 * a 4xx (the same reasoning as the tagging card).
 */
export function GarmentCapsules(props: {
  garmentId: number;
  capsules: GarmentCapsule[];
  viewOwner: number | undefined;
  canEdit: boolean;
}) {
  const { garmentId, capsules, viewOwner } = props;
  const members = capsules.filter((capsule) => capsule.member);
  if (capsules.length === 0 || (!props.canEdit && members.length === 0)) {
    return <section id={SECTION_ID}></section>;
  }
  // A row (redesign plan, "Garment page"): the label, then the chips.
  return (
    <section id={SECTION_ID} class="flex items-start gap-3">
      <h2 class="text-sm text-muted w-20 shrink-0 pt-1.5">
        {t('garment.CAPSULES')}
      </h2>
      {props.canEdit ? (
        <AutosaveForm
          action={garmentUrl(garmentId, viewOwner, '/capsules')}
          class="flex flex-col gap-1 flex-1 min-w-0"
        >
          <div class="chip-row">
            {capsules.map((capsule) => (
              <>
                <input
                  type="checkbox"
                  name="capsuleIds"
                  value={String(capsule.id)}
                  class="btn btn-sm rounded-full"
                  aria-label={capsule.name}
                  checked={capsule.member}
                />
                {/* Listed here: unchecked means "not in it" for this one only. */}
                <ShownId id={capsule.id} />
              </>
            ))}
          </div>
        </AutosaveForm>
      ) : (
        <div class="flex flex-wrap gap-2 flex-1 min-w-0">
          {members.map((capsule) => (
            <a
              href={capsuleUrl(capsule.id, viewOwner)}
              class="badge badge-outline"
            >
              {capsule.name}
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
