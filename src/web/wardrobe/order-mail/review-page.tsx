import { Card } from '../../card';
import { PostForm } from '../../form';
import { shortDayLabel } from '../../date-labels';
import { t } from '../../i18n';
import { PageShell } from '../../layout/page-shell';
import { EmptyState } from '../../layout/parts';
import type { ViewContext } from '../../view-context';
import { priceLabel } from '../garment';
import type { ReviewItem } from './queries';
import { orderItemUrl } from './urls';

/**
 * GET /wardrobe/orders: "From your orders" (#25), the owner's review list,
 * reached from the Wardrobe's ⋯ menu. What the forwarded order emails
 * named, the newest order first, each waiting to be added to the closet or
 * dismissed: never in the closet until then. Nothing of an email is shown
 * but what its product page said (name, brand, price) and its store.
 */
export function OrderReviewPage(props: {
  ctx: ViewContext;
  items: ReviewItem[];
}) {
  const { ctx, items } = props;
  return (
    <PageShell
      ctx={ctx}
      name="orders"
      bar={{ title: t('orders.TITLE'), back: '/wardrobe' }}
      body={{ gap: 4 }}
    >
      <p class="text-sm text-muted">{t('orders.INTRO')}</p>
      {items.length === 0 ? (
        <EmptyState message={t('orders.EMPTY')}>
          <a href="/wardrobe" class="btn btn-outline btn-sm">
            {t('orders.BACK_TO_CLOSET')}
          </a>
        </EmptyState>
      ) : (
        <ul class="flex flex-col gap-3" id="order-items">
          {items.map((item) => (
            <OrderItemCard item={item} />
          ))}
        </ul>
      )}
    </PageShell>
  );
}

function OrderItemCard({ item }: { item: ReviewItem }) {
  const store = new URL(item.productUrl).hostname.replace(/^www\./, '');
  return (
    <Card
      as="li"
      variant="content"
      bodyClass="p-3 gap-1"
      id={`order-item-${item.id}`}
    >
      <p class="card-title text-sm">{item.name ?? store}</p>
      <p class="text-xs text-muted truncate">
        {[
          item.brand,
          store,
          t('orders.ORDERED_ON', { date: shortDayLabel(item.orderedOn) }),
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <div class="flex flex-wrap items-center gap-2 mt-1">
        {item.price && (
          <span class="font-medium text-sm">
            {item.currency === null || item.currency === 'USD'
              ? priceLabel(item.price)
              : `${item.price} ${item.currency}`}
          </span>
        )}
        {/* http(s) only (the column's check); a new tab, as on the wishlist. */}
        <a
          href={item.productUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="link link-primary text-xs"
        >
          {t('VIEW_PRODUCT')}
        </a>
        <div class="flex gap-2 ml-auto">
          <PostForm action={orderItemUrl(item.id, 'dismiss')}>
            <button type="submit" class="btn btn-sm btn-ghost">
              {t('orders.DISMISS')}
            </button>
          </PostForm>
          <PostForm action={orderItemUrl(item.id, 'add')}>
            <button type="submit" class="btn btn-sm btn-primary">
              {t('orders.ADD_TO_CLOSET')}
            </button>
          </PostForm>
        </div>
      </div>
    </Card>
  );
}
