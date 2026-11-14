import { PostForm } from '../form';
import { t } from '../i18n';
import { categoryLabel } from '../wardrobe/garment';
import type { AvoidedPartner } from './queries';
import { IDEAS_ALLOW_PATH } from './urls';

/**
 * The garment page's "Never paired with" (the owner's alone): the garments
 * the gallery's "Clashes" set against this one, each with its undo (POST
 * /outfits/ideas/allow, the page's garment first). Nothing when there are
 * none.
 */
export function AvoidedPartners(props: {
  garmentId: number;
  partners: AvoidedPartner[];
}) {
  if (props.partners.length === 0) return null;
  return (
    <section id="garment-avoided">
      <h2 class="text-sm text-muted mb-2">{t('gallery.AVOIDED_HEADING')}</h2>
      <ul class="flex flex-col gap-1">
        {props.partners.map((partner) => (
          <li class="flex items-center justify-between gap-2">
            <a href={`/wardrobe/${partner.id}`} class="link link-hover">
              {partner.name ?? categoryLabel(partner.category)}
            </a>
            <PostForm action={IDEAS_ALLOW_PATH}>
              <input
                type="hidden"
                name="garmentId"
                value={String(props.garmentId)}
              />
              <input
                type="hidden"
                name="garmentId"
                value={String(partner.id)}
              />
              <button type="submit" class="btn btn-ghost btn-xs">
                {t('gallery.ALLOW_AGAIN')}
              </button>
            </PostForm>
          </li>
        ))}
      </ul>
    </section>
  );
}
