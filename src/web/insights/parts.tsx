import type { Child } from 'hono/jsx';
import type {
  ColourShare,
  CostPerWear,
  InsightGarment,
} from '../../wardrobe/insights';
import { Card } from '../card';
import type { SignablePhotoRef } from '../files/image-url';
import { t } from '../i18n';
import { GarmentThumb } from '../layout/parts';
import { categoryLabel, priceLabel } from '../wardrobe/garment';
import { garmentUrl } from '../wardrobe/urls';

/**
 * The pieces insights (insights-page.tsx) and the year in review
 * (recap-page.tsx) both lay their figures out with: the card, the garment
 * list, the per-wear line and the colour strip.
 */

export function InsightCard(props: {
  id: string;
  title: string;
  children: Child;
}) {
  return (
    <Card as="section" variant="content" bodyClass="p-3 gap-2" id={props.id}>
      <h2 class="font-semibold">{props.title}</h2>
      {props.children}
    </Card>
  );
}

export function garmentName(garment: InsightGarment<SignablePhotoRef>): string {
  return garment.name ?? categoryLabel(garment.category);
}

/** A row per garment: its thumb and name (linking to its page), a line, an action. */
export function GarmentList(props: {
  rows: { garment: InsightGarment<SignablePhotoRef>; detail: string }[];
  action?: (garment: InsightGarment<SignablePhotoRef>) => Child;
}) {
  if (props.rows.length === 0) return null;
  return (
    <ul class="flex flex-col gap-2">
      {props.rows.map(({ garment, detail }) => (
        <li class="flex items-center gap-3" data-garment-id={garment.id}>
          <a
            href={garmentUrl(garment.id, undefined)}
            class="flex items-center gap-3 flex-1 min-w-0"
          >
            <GarmentThumb garment={garment} class="rounded-box shrink-0" />
            <span class="flex flex-col min-w-0">
              <span class="font-medium truncate">{garmentName(garment)}</span>
              <span class="text-xs text-muted">{detail}</span>
            </span>
          </a>
          {props.action?.(garment)}
        </li>
      ))}
    </ul>
  );
}

/** "$1.20 a wear · $30.00 over 25 wears"; "Not worn yet · $30.00". */
export function perWearLine(entry: CostPerWear<SignablePhotoRef>): string {
  const cost = priceLabel(entry.cost);
  if (entry.perWear === null) return t('insights.NOT_WORN_LINE', { cost });
  const perWear = priceLabel(entry.perWear);
  return entry.garment.wearDays === 1
    ? t('insights.PER_WEAR_ONCE', { perWear })
    : t('insights.PER_WEAR_LINE', {
        perWear,
        cost,
        days: entry.garment.wearDays,
      });
}

/**
 * A colour strip: each segment as wide as its share (flex-grow over a zero
 * basis, so rounding never overflows the strip), coloured by the colour
 * swatch classes (main.css, `.swatch--<colour>`), and the
 * garments without a colour as a plain segment at the end. The recap's
 * image (public/js/recap-export.js) reads its colours from these segments.
 */
export function Strip(props: {
  name: string;
  title: string;
  colours: ColourShare[];
  share: (colour: ColourShare) => number;
  /** The garments without a colour's percent: the strip's plain end. */
  uncoloured: number;
}) {
  const { share, uncoloured } = props;
  return (
    <div data-strip={props.name}>
      <h3 class="text-sm text-muted mb-1">{props.title}</h3>
      <div
        class="flex h-5 w-full rounded-full overflow-hidden ring-1 ring-base-300"
        role="img"
        aria-label={props.title}
      >
        {props.colours
          .filter((colour) => share(colour) > 0)
          .map((colour) => (
            <span
              class={`basis-0 swatch--${colour.colour}`}
              style={`flex-grow:${share(colour)}`}
              title={`${colour.colour} ${share(colour)}%`}
              data-colour={colour.colour}
              data-share={share(colour)}
            />
          ))}
        {uncoloured > 0 && (
          <span
            class="basis-0 bg-base-300"
            style={`flex-grow:${uncoloured}`}
            title={`${t('insights.NO_COLOUR')} ${uncoloured}%`}
            data-uncoloured=""
            data-share={uncoloured}
          />
        )}
      </div>
    </div>
  );
}
