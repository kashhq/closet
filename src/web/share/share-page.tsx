import { Card } from '../card';
import { imageUrl } from '../files/image-url';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { GarmentThumb, HangerIcon } from '../layout/parts';
import { FootMark } from '../outfits/collage';
import { isPieceToBuy } from '../outfits/references';
import type { ViewContext } from '../view-context';
import type { SharedGarment, SharedOutfit } from './queries';

export type Shared =
  | { type: 'garment'; garment: SharedGarment }
  | { type: 'outfit'; outfit: SharedOutfit };

/** What link-preview crawlers read from the page's Open Graph tags. */
export interface SharePreview {
  url: string;
  title?: string;
  description?: string;
  /** The watermarked photo; the app icon when the item has none. */
  image?: string;
}

/**
 * Who the page and its preview say shared the item: the owner's first name
 * if they set one, else nobody. Never the email: the page is public, and
 * link-preview crawlers keep what they read.
 */
export function sharedBy(owner: { firstName: string | null }) {
  return owner.firstName?.trim() || undefined;
}

/**
 * GET /share: the landing page of a garment or outfit share link, opened by
 * whoever the link was sent to and fetched by link-preview crawlers. An
 * unknown link renders the empty page, as it always has.
 */
export function SharePage(props: {
  ctx: ViewContext;
  shared: Shared | undefined;
  preview: SharePreview | undefined;
}) {
  const { ctx, shared, preview } = props;
  return (
    <Layout
      ctx={ctx}
      ogUrl={preview?.url}
      ogTitle={preview?.title}
      ogDescription={preview?.description}
      ogImage={preview?.image}
    >
      <AppBar ctx={ctx} title={ctx.appName} />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto flex flex-col items-center gap-6">
        {shared && <SharedItem shared={shared} />}
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

function SharedItem({ shared }: { shared: Shared }) {
  const owner = sharedBy(
    shared.type === 'garment' ? shared.garment.owner : shared.outfit.owner,
  );
  return (
    <>
      {shared.type === 'garment' ? (
        <GarmentCard garment={shared.garment} />
      ) : (
        <OutfitCard outfit={shared.outfit} />
      )}
      {owner && (
        <div class="fixed bottom-dock left-rail right-0 p-4 bg-gradient-to-t from-base-100 via-base-100/50 to-transparent">
          <div class="flex flex-row gap-2 items-center justify-center">
            <p>
              {t('SHARED_BY')} {owner}
            </p>
          </div>
        </div>
      )}
    </>
  );
}

function GarmentCard({ garment }: { garment: SharedGarment }) {
  return (
    <Card variant="content" class="w-full max-w-sm">
      {garment.photo ? (
        <figure class="aspect-square overflow-hidden">
          <img
            src={imageUrl(garment.photo, 'nobg')}
            alt={garment.name ?? ''}
            class="object-cover w-full h-full"
          />
        </figure>
      ) : (
        <div class="aspect-square bg-base-200 flex items-center justify-center text-faint">
          <HangerIcon class="size-20" strokeWidth="1" />
        </div>
      )}
      <div class="card-body gap-2">
        <h2 class="card-title">{garment.name}</h2>
        <p class="capitalize text-muted text-sm">{garment.category}</p>
        {garment.brand && <p class="text-sm">{garment.brand}</p>}
      </div>
    </Card>
  );
}

function OutfitCard({ outfit }: { outfit: SharedOutfit }) {
  return (
    <Card variant="content" class="w-full max-w-sm" bodyClass="gap-4">
      <h2 class="card-title">{outfit.name}</h2>
      {outfit.notes && <p class="text-muted text-sm">{outfit.notes}</p>}
      {outfit.garments.length > 0 && (
        <div class="flex flex-wrap gap-2">
          {outfit.garments.map((garment) =>
            isPieceToBuy(garment) ? (
              <span class="relative">
                <GarmentThumb garment={garment} class="rounded-box" />
                <FootMark marks={['to-buy']} />
              </span>
            ) : (
              <GarmentThumb garment={garment} class="rounded-box" />
            ),
          )}
        </div>
      )}
    </Card>
  );
}
