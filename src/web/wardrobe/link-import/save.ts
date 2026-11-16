import type { EntryStatus } from '../../../wardrobe/status';
import type { FieldErrors } from '../../auth/validation';
import { HttpError } from '../../errors';
import { t } from '../../i18n';
import type { WardrobeAccess } from '../../sharing/access';
import { normalizeCategory } from '../garment';
import {
  formPost,
  type GarmentField,
  type GarmentFields,
  type GarmentFormValues,
  readGarmentForm,
  withPresets,
} from '../garment-input';
import {
  createGarment,
  createGarmentWithPendingPhoto,
  discardPendingPhoto,
  type WardrobeDeps,
  type WithGarment,
} from '../writes';
import {
  importLink,
  type LinkImport,
  type LinkImportDeps,
  LinkImportError,
  REFUSALS,
  reasonLed,
  reasonLedMessage,
} from './import';
import type { ExtractionConfidence } from './extract';
import { importedForm } from './prefill';
import type { WriteOrigin } from '../../write-origin';

/** What the caller says instead of the page. */
export interface LinkOverrides {
  url: string;
  /** Where it lands (MCP's default is the wishlist, the API's the closet). */
  destination: EntryStatus;
  /** A wishlist item's replaced garment (stored only if the owner's; replacementOf). */
  replacesGarmentId?: number;
  name?: string;
  category?: string;
  type?: string;
  size?: string;
  /** The listed price, '149.00' (the form's own field: it validates it). */
  price?: string;
  notes?: string;
}

export interface LinkSaveOptions {
  /** More rows the save writes with the garment (suggest_garment's provenance, #337). */
  withGarment?: WithGarment;
}

/** Who saves, for the log lines: the surface's name. */
export type LinkSaveSurface = 'MCP' | 'API';

/** The save, or the garment form's refusal (the fetched photo discarded). */
export interface LinkSaved {
  ok: true;
  id: number;
  /** Warnings first: what the import says about itself, as the page shows it. */
  notices: string[];
  /** How much of a product the page gave; null when the link was an image. */
  confidence: ExtractionConfidence | null;
}

export type LinkSave =
  | LinkSaved
  | { ok: false; errors: FieldErrors<GarmentField> };

/**
 * The link import (#6) and the garment form's save in one step, with
 * nobody to review the form: MCP's add_garment_from_link and suggest_garment,
 * and the API's POST /garments/link-imports (#192c). importLink fetches
 * through the outbound fetcher and stores the first readable photo as
 * `userId`'s pending photo; importedForm prefills the form as the page
 * does; the overrides replace fields (a new category or type brings its
 * presets, as the form's chips do); then the form's own post goes through
 * readGarmentForm and the save that claims the photo
 * (createGarmentWithPendingPhoto). A refused form discards the photo it
 * fetched and is answered for the caller to word. The photo choices the
 * page would offer are not: the first is kept, and the garment's photo
 * changes it afterwards.
 *
 * The caller has authorized `ownerId`'s wardrobe (MANAGE or owner) and
 * counted the fetch against its rate limit. A refused fetch is a 400 or
 * 422 whose message leads with its reason (`blocked-by-site`: a shop that
 * refuses automated fetches, so another retailer, not a retry; #347): the
 * page's 502 (the shop's failure) would be a 5xx without detail on the API.
 */
export async function saveGarmentFromLink(
  deps: WardrobeDeps & Pick<LinkImportDeps, 'fetcher'>,
  userId: number,
  { ownerId, isOwner }: Pick<WardrobeAccess, 'ownerId' | 'isOwner'>,
  overrides: LinkOverrides,
  surface: LinkSaveSurface,
  madeBy: WriteOrigin,
  { withGarment }: LinkSaveOptions = {},
): Promise<LinkSave> {
  const { logger } = deps;
  let imported: LinkImport;
  try {
    imported = await importLink(deps, overrides.url, userId);
  } catch (error) {
    if (!(error instanceof LinkImportError)) throw error;
    logger.warn(
      `Link import by user ${userId} (${surface}) refused (${error.reason})`,
    );
    const { status } = REFUSALS[error.reason];
    throw new HttpError(
      status < 500 ? status : 422,
      reasonLedMessage(error.reason),
    );
  }
  if (unreadWithoutName(imported, overrides)) {
    // A title-only read prefills nothing but the link, so saving would be a
    // bare field refusal: say what happened and what to send, and save nothing
    // (no photo was fetched for it).
    logger.warn(
      `Link import by user ${userId} (${surface}) read only a title: nothing saved without a name`,
    );
    const message = t('linkImport.TITLE_ONLY_SEND_NAME');
    throw new HttpError(422, reasonLed('title-only', message), {
      validation: [{ path: 'body/name', message }],
    });
  }
  const form = importedForm(imported, overrides.url);
  const photo = form.link.photo;
  const posted = formPost(withOverrides(form.values, overrides));
  const read = readGarmentForm(posted, { owner: isOwner });
  if (!read.ok) {
    if (photo) {
      await discardPendingPhoto(deps, photo, { userId, ownerId });
    }
    return { ok: false, errors: read.errors };
  }
  let id: number | undefined;
  try {
    id = await saveImported(deps, ownerId, userId, read.fields, {
      photo,
      destination: overrides.destination,
      madeBy,
      withGarment,
    });
  } catch (error) {
    // A refusal from `withGarment` (suggest_garment's mark) rolled the
    // garment back: its photo is nobody's, like a refused form's. A
    // failed discard is logged; the refusal is still the answer.
    if (photo) {
      await discardPendingPhoto(deps, photo, { userId, ownerId }).catch(
        (discardError: unknown) => {
          logger.error(
            { err: discardError },
            `Pending photo ${photo} of user ${userId} not discarded after a refused save (${surface})`,
          );
        },
      );
    }
    throw error;
  }
  if (id === undefined) {
    // Claimed or evicted between the import and the save (the same user's
    // tenth import meanwhile): nothing was written.
    throw new HttpError(409, t('linkImport.PHOTO_GONE'));
  }
  logger.info(
    `Garment ${id} added from a link by user ${userId} into wardrobe ${ownerId} (${overrides.destination}, ${surface}): ${imported.kind}${photo ? `, photo ${photo}` : ', no photo'}`,
  );
  return {
    ok: true,
    id,
    notices: [...form.link.warnings, ...form.link.notices],
    confidence: imported.kind === 'page' ? imported.product.confidence : null,
  };
}

/** A page read as `title-only` and the caller named no garment. */
function unreadWithoutName(
  imported: LinkImport,
  overrides: LinkOverrides,
): boolean {
  return (
    imported.kind === 'page' &&
    imported.product.confidence === 'title-only' &&
    !overrides.name?.trim()
  );
}

/**
 * The imported garment saved in `ownerId`'s wardrobe, claiming its pending
 * photo when it has one; undefined when that photo was claimed or evicted
 * meanwhile (nothing was written).
 */
async function saveImported(
  deps: WardrobeDeps,
  ownerId: number,
  userId: number,
  fields: GarmentFields,
  {
    photo,
    destination,
    madeBy,
    withGarment,
  }: {
    photo: string | undefined;
    destination: EntryStatus;
    madeBy: WriteOrigin;
    withGarment: WithGarment | undefined;
  },
): Promise<number | undefined> {
  if (!photo) {
    return createGarment(
      deps,
      ownerId,
      fields,
      destination,
      madeBy,
      withGarment,
    );
  }
  const claimed = await createGarmentWithPendingPhoto(
    deps,
    ownerId,
    userId,
    fields,
    photo,
    destination,
    madeBy,
    withGarment,
  );
  return claimed?.id;
}

function withOverrides(
  values: GarmentFormValues,
  overrides: LinkOverrides,
): GarmentFormValues {
  const category =
    overrides.category === undefined
      ? values.category
      : normalizeCategory(overrides.category);
  const type = overrides.type ?? values.properties.type;
  const kindChanged =
    category !== values.category || type !== values.properties.type;
  return {
    ...values,
    name: overrides.name ?? values.name,
    category,
    size: overrides.size ?? values.size,
    price: overrides.price ?? values.price,
    notes: overrides.notes ?? values.notes,
    replaces:
      overrides.replacesGarmentId === undefined
        ? values.replaces
        : String(overrides.replacesGarmentId),
    properties: kindChanged
      ? withPresets({ ...values.properties, type }, category)
      : values.properties,
  };
}
