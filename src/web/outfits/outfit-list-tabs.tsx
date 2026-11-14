import { t } from '../i18n';
import { LinkTabs } from '../layout/link-tabs';
import { type OutfitList, withOutfitList } from './outfit-list';

/**
 * The two lists as link tabs above a saved-outfit list. `href` is the
 * page's own address without `show` (its destination kept), so switching
 * keeps what the page was picking for.
 */
export function OutfitListTabs(props: { list: OutfitList; href: string }) {
  return (
    <LinkTabs
      active={props.list}
      class="tabs tabs-border tabs-sm mx-2"
      tabs={[
        {
          name: 'kept',
          href: withOutfitList(props.href, 'kept'),
          label: t('outfits.LIST_KEPT'),
        },
        {
          name: 'one-offs',
          href: withOutfitList(props.href, 'one-offs'),
          label: t('outfits.LIST_ONE_OFFS'),
        },
      ]}
    />
  );
}
