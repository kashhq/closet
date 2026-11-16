import { type GarmentRole, gsmToOz } from '../../wardrobe/properties';
import { t, type CopyKey, tKey, type Translated } from '../i18n';

/**
 * The words for the property values (src/wardrobe/properties.ts owns the
 * values; src/i18n/en/lang.json's `property` group holds one string per
 * value, which labels.spec.ts checks for every set). Used by the form, the
 * garment page and the filters.
 */

export type LabelledProperty =
  | 'type'
  | 'color'
  | 'warmth'
  | 'formality'
  | 'materials'
  | 'pattern'
  | 'fit'
  | 'sleeve'
  | 'length'
  | 'condition'
  | 'careWash'
  | 'careBleach'
  | 'careDry'
  | 'careIron'
  | 'careDryClean'
  | 'repairKind';

export function valueLabel(
  property: LabelledProperty,
  value: string | number,
): Translated {
  return tKey(`property.${property}.${value}`);
}

/** "6 oz · 203 gsm". */
export function fabricWeightLabel(gsm: number): string {
  return t('FABRIC_WEIGHT_VALUE', { oz: gsmToOz(gsm), gsm });
}

/**
 * A role as a heading over its garments, plural ("Tops", "Shoes"): a trip's
 * packing list, goes-with's roles, a plan's sections. One garment of it is
 * `roleLabel`, singular (Styling's rows, a look's pieces).
 */
export function roleGroupLabel(role: GarmentRole): string {
  return t(`roles.${role}`);
}

const ROLE_LABELS: Record<GarmentRole, CopyKey> = {
  layer: 'styling.role.layer',
  'one-piece': 'styling.role.one-piece',
  top: 'styling.role.top',
  bottom: 'styling.role.bottom',
  footwear: 'styling.role.footwear',
  accessory: 'styling.role.accessory',
  bag: 'styling.role.bag',
  none: 'styling.role.none',
};

/** One garment of a role, singular ("Top", "Shoes"). */
export function roleLabel(role: GarmentRole): Translated {
  return t(ROLE_LABELS[role]);
}
