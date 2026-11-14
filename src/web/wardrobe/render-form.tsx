import type { FastifyReply } from 'fastify';
import type { Db } from '../../db/client';
import { type PendingScope, pendingPhotoOf } from '../files/pending-photos';
import { t } from '../i18n';
import { NotFound } from '../refusals';
import { renderPage } from '../render';
import { viewContext } from '../view-context';
import type { DraftQueue } from './draft-queue';
import {
  type FormContext,
  formContext,
  type FormContextParts,
} from './form-context';
import { categoryLabel, categorySuggestions } from './garment';
import {
  addsToCloset,
  type GarmentFormModel,
  GarmentFormPage,
  isWishlistForm,
} from './garment-form';
import { pendingPhotoView } from './link-import/photo-choice';
import type { RepairPanelRequest } from './repairs';

/**
 * The pending photo a new garment form holds (an add-sheet upload, a draft
 * of a batch, #200), judged in the form's statement: a draft of another
 * wardrobe than the one addressed is a 404, and a draft gets its queue.
 * `sayGone` (GET /wardrobe/new?photo=) shows a photo no longer the
 * requester's as "no longer available"; a refused save keeps the photo it
 * posted either way (its claim is the check that counts).
 */
interface FormPendingPhoto {
  fileName: string;
  scope: PendingScope;
  sayGone: boolean;
  /** The queue's navigation state, carried through the form. */
  carried: Pick<DraftQueue, 'saved' | 'leftOut'>;
}

/** A garment form to render: the model without what is read here, and where from. */
export interface GarmentFormRequest extends Omit<
  GarmentFormModel,
  | 'categories'
  | 'replaceable'
  | 'brandSize'
  | 'lookalikes'
  | 'repairs'
  | 'draft'
> {
  /** The wardrobe whose categories are suggested: where the garment lands. */
  suggestionsFrom: number;
  /** The duplicate check's "Not the same" ids a refused save posted back. */
  lookalikesDismissed?: readonly number[];
  /** The edit page's repair editor (repairPanel), whose log is read here. */
  repairs?: RepairPanelRequest;
  pendingPhoto?: FormPendingPhoto;
}

/** The requester's draft addressed through another wardrobe than its batch's (#200). */
function draftNotFound(): NotFound {
  return new NotFound('draft', { logDetail: 'a draft of another wardrobe' });
}

/**
 * After a save's claim or a Discard that took nothing: a draft of another
 * wardrobe is the 404 its form answers (#200); anything else (claimed,
 * discarded, evicted) is the caller's to answer, so this returns.
 */
export async function refuseOtherWardrobesDraft(
  db: Db,
  fileName: string,
  scope: PendingScope,
): Promise<void> {
  if ((await pendingPhotoOf(db, fileName, scope)) === 'otherWardrobe') {
    throw draftNotFound();
  }
}

/**
 * The garment form page (new, edit, clone, and a new one prefilled from a
 * link): the wardrobe routes, the repair log's refused entry and the link
 * import's (link-import/routes.tsx) all end here. Everything the form
 * reads is one statement (formContext): a wishlist form's "Replaces"
 * choices, the note of the brand it names on the requester's own wardrobe
 * (#24; never on a shared wardrobe: the notes are the requester's body),
 * for a form that adds to the closet the duplicate check (#20) over the
 * values it opens with (a link import's, a clone's, a refused save's), the
 * edit page's repair log and the pending photo it holds.
 */
export async function renderGarmentForm(
  reply: FastifyReply,
  db: Db,
  request: GarmentFormRequest,
  status = 200,
): Promise<FastifyReply> {
  const {
    suggestionsFrom,
    lookalikesDismissed,
    repairs,
    pendingPhoto,
    ...model
  } = request;
  const reads: FormReads = {
    suggestionsFrom,
    lookalikesDismissed: lookalikesDismissed ?? [],
    repairs,
    pendingPhoto,
  };
  const context = await formContext(db, contextParts(model, reads));
  return renderPage(
    reply,
    <GarmentFormPage
      ctx={viewContext(reply)}
      model={formModel(model, reads, context)}
    />,
    { status },
  );
}

/** What a GarmentFormRequest asks to be read, beside the model it renders. */
type FormModelRequest = Omit<GarmentFormRequest, keyof FormReads>;
interface FormReads {
  suggestionsFrom: number;
  lookalikesDismissed: readonly number[];
  repairs: RepairPanelRequest | undefined;
  pendingPhoto: FormPendingPhoto | undefined;
}

/** Which parts the form reads (FormContextParts), from its mode and audience. */
function contextParts(
  { mode, values, viewOwner }: FormModelRequest,
  { suggestionsFrom, lookalikesDismissed, repairs, pendingPhoto }: FormReads,
): FormContextParts {
  return {
    categoriesOf: suggestionsFrom,
    replaceable: isWishlistForm(mode)
      ? {
          ownerId: suggestionsFrom,
          chosen: Number(values.replaces) || undefined,
        }
      : undefined,
    // The requester's own wardrobe: suggestionsFrom is the requester.
    brandSize:
      viewOwner === undefined
        ? { userId: suggestionsFrom, brand: values.brand }
        : undefined,
    lookalikes: addsToCloset(mode)
      ? {
          ownerId: suggestionsFrom,
          fields: {
            category: values.category,
            type: values.properties.type,
            colors: values.colors,
            brand: values.brand,
          },
          dismissed: lookalikesDismissed,
        }
      : undefined,
    repairsOf: repairs?.garmentId,
    pending: pendingPhoto && {
      fileName: pendingPhoto.fileName,
      scope: pendingPhoto.scope,
    },
  };
}

/** The form's model: the request's, with what formContext read. */
function formModel(
  model: FormModelRequest,
  { lookalikesDismissed, repairs, pendingPhoto }: FormReads,
  context: FormContext,
): GarmentFormModel {
  const photo = pendingPhoto && pendingPhotoOnForm(pendingPhoto, context);
  return {
    ...model,
    link: photo?.link ?? model.link,
    draft: photo?.draft,
    errors: { ...model.errors, ...photo?.errors },
    replaceable: context.replaceable,
    brandSize: context.brandSize,
    lookalikes: context.lookalikes && {
      matches: context.lookalikes,
      dismissed: lookalikesDismissed,
      // A clone lands in the requester's own wardrobe, whatever it was
      // cloned from.
      viewOwner: model.mode.kind === 'clone' ? undefined : model.viewOwner,
    },
    repairs: repairs && { ...repairs, entries: context.repairs ?? [] },
    categories: categorySuggestions(context.categories).map(categoryLabel),
  };
}

/** What the form shows of its pending photo, as formContext found it. */
function pendingPhotoOnForm(
  photo: FormPendingPhoto,
  { pending }: FormContext,
): Pick<GarmentFormModel, 'link' | 'draft' | 'errors'> {
  if (pending === 'otherWardrobe') throw draftNotFound();
  if (!pending) {
    return photo.sayGone
      ? {
          link: pendingPhotoView(undefined),
          errors: { linkPhoto: [t('add.PHOTO_GONE')] },
        }
      : { link: pendingPhotoView(photo.fileName) };
  }
  return {
    link: pendingPhotoView(photo.fileName),
    draft: pending.draft && {
      current: photo.fileName,
      waiting: pending.draft.waiting,
      ...photo.carried,
    },
  };
}
