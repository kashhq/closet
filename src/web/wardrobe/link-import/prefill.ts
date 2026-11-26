import { t } from '../../i18n';
import {
  BLANK_GARMENT_VALUES,
  BLANK_PROPERTIES,
  type GarmentFormValues,
  withPresets,
} from '../garment-input';
import type { ExtractedProduct } from './extract';
import type { LinkImport } from './import';
import type { LinkImportView } from './photo-choice';

/** The household's one currency (priceLabel on the garment page). */
const HOUSEHOLD_CURRENCY = 'USD';

/**
 * The garment form an import opens: the values it prefills and what the
 * form says about the import. Pure. `link` is the link as the person gave
 * it, kept as the product link (a page's redirects can end on a consent or
 * tracking address).
 */
export function importedForm(
  result: LinkImport,
  link: string,
): { values: GarmentFormValues; link: LinkImportView } {
  if (result.kind === 'image') {
    return {
      values: BLANK_GARMENT_VALUES,
      link: {
        photo: result.photo,
        choices: [],
        notices: [t('linkImport.PHOTO_ONLY')],
        warnings: [],
      },
    };
  }
  const { product, photo, choices } = result;
  if (product.confidence === 'title-only') {
    // The page's title is a marketing headline or the shop's name, not the
    // garment's: keep the link, claim nothing.
    return {
      values: { ...BLANK_GARMENT_VALUES, sourceUrl: link },
      link: {
        photo,
        choices,
        notices: [],
        warnings: [
          t(
            product.source === null
              ? 'linkImport.NOTHING_FOUND'
              : 'linkImport.TITLE_ONLY',
          ),
        ],
      },
    };
  }
  const price = householdPrice(product);
  return {
    values: productValues(product, link, price),
    link: {
      photo,
      choices,
      warnings: [],
      notices: [
        t('linkImport.FOUND_DETAILS'),
        ...(photo ? [] : [t('linkImport.NO_PHOTO')]),
        ...(product.price && price === ''
          ? [
              t('linkImport.PRICE_CURRENCY', {
                currency: product.price.currency ?? '',
              }),
            ]
          : []),
      ],
    },
  };
}

/**
 * The product's fields as the form shows them. The category's presets fill
 * what the page did not say (as choosing the category by hand would), and
 * the hidden preset fields record where they came from, so a later type
 * change moves only values still at a preset. A stated weight shows in gsm,
 * as pages state it.
 */
function productValues(
  product: ExtractedProduct,
  link: string,
  price: string,
): GarmentFormValues {
  const category = product.category ?? '';
  return {
    ...BLANK_GARMENT_VALUES,
    name: product.name ?? '',
    brand: product.brand ?? '',
    category,
    colors: product.colors,
    sourceUrl: link,
    price,
    properties: withPresets(
      {
        ...BLANK_PROPERTIES,
        type: product.type ?? '',
        sleeve: product.sleeve ?? '',
        warmth: product.warmth === null ? '' : String(product.warmth),
        materials: product.materials,
        fabricWeight:
          product.fabricWeight === null ? '' : String(product.fabricWeight),
        fabricWeightUnit: 'gsm',
      },
      category,
    ),
  };
}

/** The page's price when it is in dollars or names no currency; else ''. */
function householdPrice({ price }: ExtractedProduct): string {
  if (!price) return '';
  const { amount, currency } = price;
  return currency === null || currency === HOUSEHOLD_CURRENCY ? amount : '';
}
