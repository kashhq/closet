import {
  applyPresets,
  GARMENT_COLORS,
  pieceCategory,
  propertyApplies,
  storedSet,
} from '../../wardrobe/properties';
import type { LookPiece } from '../../wardrobe/recreate';
import { t } from '../i18n';
import type { GarmentFields } from '../wardrobe/garment-input';
import { valueLabel } from '../wardrobe/labels';
import { lookName } from './look-name';

/**
 * A wishlist item's fields from a look's piece: its role's category, its
 * type (named by it, as the form would show it) with the presets the type
 * implies, its colours, its pattern where the category has one, and a note
 * naming the look. Not the look's link as the product link: a lookbook
 * page or a pin is not where the piece is sold, and two pieces of one look
 * would read as one product to the agent's never-again rule (suggestions.md).
 */
export function wishlistFieldsOf(
  piece: LookPiece,
  look: { title: string | null; sourceUrl: string | null },
): GarmentFields {
  const category = pieceCategory(piece.role);
  const name = lookName(look);
  const presets = applyPresets(
    {
      warmth: null,
      formality: null,
      sleeve: null,
      length: null,
      waterResistant: false,
    },
    null,
    { category, type: piece.type, fabricWeight: null },
  );
  return {
    name: piece.type ? valueLabel('type', piece.type) : null,
    category,
    brand: null,
    colors: storedSet(GARMENT_COLORS, piece.colors),
    size: null,
    notes: look.sourceUrl
      ? t('inspiration.FOUND_NOTE_LINK', { look: name, link: look.sourceUrl })
      : t('inspiration.FOUND_NOTE', { look: name }),
    washingDetails: null,
    acquiredOn: null,
    type: piece.type,
    pattern: propertyApplies('pattern', category) ? piece.pattern : null,
    ...presets,
  };
}
