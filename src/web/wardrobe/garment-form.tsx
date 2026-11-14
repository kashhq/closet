import {
  NEVER_WASH,
  QUANTITY_MAX,
  WASH_AFTER_CHOICES,
} from '../../wardrobe/availability';
import { CONDITIONS } from '../../wardrobe/properties';
import type { FieldErrors } from '../auth/validation';
import { t } from '../i18n';
import { FormPage } from '../layout/form-page';
import { FieldMessages, FormField, inputAttributes } from '../form-field';
import type { ViewContext } from '../view-context';
import { GARMENT_COLORS } from '../../wardrobe/properties';
import { categoryLabel, normalizeCategory } from './garment';
import { valueLabel } from './labels';
import {
  LinkImportSection,
  type LinkImportView,
} from './link-import/photo-choice';
import {
  PropertiesMain,
  PropertiesMore,
  REFRESH_PROPERTIES,
} from './property-fields';
import type { NeedBoughtFor } from '../wishlist/inbox';
import type { ReplaceableGarment } from '../wishlist/queries';
import type { BrandSize } from '../sizes/queries';
import { BRAND_SIZE_HINT_TRIGGER, BrandSizeHint } from '../sizes/views';
import { type DraftQueue, DraftQueueSection } from './draft-queue';
import {
  LookalikeCopyForm,
  type LookalikesPanel,
  LookalikesRegion,
} from './lookalike-region';
import { RepairEditor } from './repair-log';
import type { RepairPanel } from './repairs';
import {
  type Destination,
  destinationParams,
  garmentUrl,
  idListValue,
  LINK_IMPORT_PATH,
  wardrobeUrl,
  WISHLIST_PATH,
} from './urls';
import {
  BRAND_MAX,
  CARE_NOTE_MAX,
  type CareFormValues,
  CATEGORY_MAX,
  formAudience,
  type GarmentField,
  type GarmentFormValues,
  NAME_MAX,
  PRICE_INPUT_MAX,
  SIZE_MAX,
  SOURCE_URL_MAX,
  TEXT_MAX,
} from './garment-input';

/**
 * Which form: a new garment (to the closet or the wishlist), an edit (of a
 * wishlist item, or not), or a clone of `garmentId`.
 */
export type GarmentFormMode =
  | { kind: 'new'; destination: Destination }
  | { kind: 'edit'; garmentId: number; wishlist: boolean }
  | { kind: 'clone'; garmentId: number; wishlist: boolean };

/**
 * A form whose save puts a new garment in the closet: a new one there, or
 * a clone of a closet garment (a wishlist item's clone lands on the
 * wishlist, statusOfClone). Where the duplicate check (#20) runs.
 */
export function addsToCloset(mode: GarmentFormMode): boolean {
  if (mode.kind === 'new') return mode.destination.to === 'closet';
  return mode.kind === 'clone' && !mode.wishlist;
}

/** A form for a wishlist item: a new one, or an edit of one. */
export function isWishlistForm(mode: GarmentFormMode): boolean {
  return (
    (mode.kind === 'new' && mode.destination.to === 'wishlist') ||
    (mode.kind === 'edit' && mode.wishlist)
  );
}

export interface GarmentFormModel {
  mode: GarmentFormMode;
  values: GarmentFormValues;
  /** The category suggestions (built-in, then the wardrobe's own). */
  categories: { value: string; label: string }[];
  /** The shared wardrobe the form was opened in; undefined for one's own. */
  viewOwner: number | undefined;
  errors?: FieldErrors<GarmentField>;
  /**
   * A new garment form with a pending photo: prefilled from a link
   * (link-import/routes.tsx), or started from an upload (GET
   * /wardrobe/new?photo=).
   */
  link?: LinkImportView;
  /** A wishlist form's "Replaces" choices (renderGarmentForm reads them). */
  replaceable?: ReplaceableGarment[];
  /** The owner's Muse need a new closet garment is bought for instead of its picks (#333; its destination's forNeed). */
  boughtFor?: NeedBoughtFor;
  /**
   * The requester's note on the form's brand (#24), under Size; read, and
   * the brand field refreshing it, only on the requester's own wardrobe
   * (renderGarmentForm).
   */
  brandSize?: BrandSize;
  /**
   * The repair log's editor (#23), below the form: the owner's edit of an
   * owned garment only (repairPanel, repairs.ts).
   */
  repairs?: RepairPanel;
  /**
   * The duplicate check (#20), under Brand and Size: a form that adds to
   * the closet only (addsToCloset; renderGarmentForm reads it).
   */
  lookalikes?: LookalikesPanel;
  /**
   * A draft of a multi-photo batch (#200): its queue above the form, the
   * category asked first, and the save moving on to the next draft.
   */
  draft?: DraftQueue;
}

const TITLES = {
  new: 'NEW_GARMENT',
  edit: 'EDIT_GARMENT',
  clone: 'CLONE_GARMENT',
} as const;

function formTitle(mode: GarmentFormMode): string {
  return mode.kind === 'new' && mode.destination.to === 'wishlist'
    ? t('wishlist.ADD_TITLE')
    : t(TITLES[mode.kind]);
}

/** Where Cancel and the back arrow go. */
function backUrl({ mode, viewOwner }: GarmentFormModel): string {
  if (mode.kind !== 'new') return garmentUrl(mode.garmentId, viewOwner);
  return mode.destination.to === 'wishlist'
    ? wardrobeUrl(viewOwner, {}, WISHLIST_PATH)
    : wardrobeUrl(viewOwner);
}

function formAction({ mode, viewOwner }: GarmentFormModel): string {
  switch (mode.kind) {
    case 'new':
      return wardrobeUrl(viewOwner);
    case 'edit':
      return garmentUrl(mode.garmentId, viewOwner);
    case 'clone':
      return garmentUrl(mode.garmentId, viewOwner, '/clone');
  }
}

/**
 * GET /wardrobe/new, /wardrobe/:id/edit and /wardrobe/:id/clone, and their
 * re-render with the messages when a post is refused (400), in the shared
 * add/edit frame (`FormPage`: a native post, disabled offline, #411; a
 * batch's draft queue does not cover the save itself, only its Discard).
 * Field names are the ones the form has always posted (cached pages of the
 * installed app still send them), dateAquired included.
 */
export function GarmentFormPage(props: {
  ctx: ViewContext;
  model: GarmentFormModel;
}) {
  const { ctx, model } = props;
  const { mode, values, viewOwner, link, draft, errors = {} } = model;
  const back = backUrl(model);
  const wishlist = isWishlistForm(mode);
  const title = formTitle(mode);
  const category = normalizeCategory(values.category);
  return (
    <FormPage
      ctx={ctx}
      title={title}
      back={back}
      action={formAction(model)}
      submitLabel={t('SAVE')}
      intro={
        <>
          {draft && <DraftQueueSection queue={draft} viewOwner={viewOwner} />}
          {mode.kind === 'new' && !link && (
            <a
              href={wardrobeUrl(
                viewOwner,
                destinationParams(mode.destination),
                LINK_IMPORT_PATH,
              )}
              class="btn btn-outline btn-sm w-full mb-4"
            >
              {t('linkImport.ADD_FROM_LINK')}
            </a>
          )}
        </>
      }
      after={
        <>
          {model.lookalikes && <LookalikeCopyForm />}
          {model.repairs && <RepairEditor panel={model.repairs} />}
        </>
      }
    >
      {link && (
        <LinkImportSection
          link={link}
          viewOwner={viewOwner}
          errors={errors.linkPhoto}
        />
      )}
      {draft && (
        <input
          type="hidden"
          name="draftsSaved"
          value={idListValue(draft.saved)}
        />
      )}
      <NameAndCategory model={model} category={category} />
      <ColorMultiSelect selected={values.colors} errors={errors.color} />
      <BrandAndSize model={model} />
      <OwnershipFields model={model} wishlist={wishlist} />
      <MoreDetails model={model} wishlist={wishlist} category={category} />
    </FormPage>
  );
}

/**
 * The name, the category and what the category suggests (its type,
 * warmth and weight). A draft of a batch (#200) asks the category first,
 * so its properties follow it before anything else is typed.
 */
function NameAndCategory(props: { model: GarmentFormModel; category: string }) {
  const { model, category } = props;
  const { values, errors = {} } = model;
  const name = (
    <TextField
      name="name"
      label={t('NAME')}
      value={values.name}
      maxlength={NAME_MAX}
      placeholder={t('NAME_PLACEHOLDER')}
    />
  );
  return (
    <>
      {!model.draft && name}
      <FormField
        id="garment-category"
        label={t('CATEGORY')}
        required
        messages={errors.category}
      >
        <input
          {...inputAttributes('garment-category', 'w-full', errors.category)}
          type="text"
          name="category"
          list="category-suggestions"
          value={values.category}
          maxlength={CATEGORY_MAX}
          required
          placeholder={t('TYPE_OR_SELECT_CATEGORY')}
          autocomplete="off"
          {...REFRESH_PROPERTIES}
        />
        <datalist id="category-suggestions">
          {model.categories.map((suggestion) => (
            <option value={suggestion.value}>{suggestion.label}</option>
          ))}
        </datalist>
      </FormField>
      <PropertiesMain
        category={category}
        values={values.properties}
        errors={errors.fabricWeight}
      />
      {model.draft && name}
    </>
  );
}

/**
 * Brand and size, then what they (and the fields above) tell: the
 * requester's own note on the brand (#24; their body, so only on their own
 * wardrobe) and the duplicate check (#20) when the form adds to the closet.
 */
function BrandAndSize({ model }: { model: GarmentFormModel }) {
  const { values, viewOwner } = model;
  const own = viewOwner === undefined;
  return (
    <>
      <TextField
        name="brand"
        label={t('BRAND')}
        value={values.brand}
        maxlength={BRAND_MAX}
        placeholder={t('BRAND_PLACEHOLDER')}
        refresh={own ? BRAND_SIZE_HINT_TRIGGER : {}}
      />
      <TextField
        name="size"
        label={t('SIZE')}
        value={values.size}
        maxlength={SIZE_MAX}
        placeholder={t('SIZE_PLACEHOLDER')}
      />
      {own && <BrandSizeHint note={model.brandSize} />}
      {model.lookalikes && <LookalikesRegion panel={model.lookalikes} />}
    </>
  );
}

/**
 * What depends on whether the garment is owned: copies for the closet's
 * form, what it replaces for a wishlist form.
 */
function OwnershipFields(props: {
  model: GarmentFormModel;
  wishlist: boolean;
}) {
  const { model, wishlist } = props;
  const { values, mode, errors = {} } = model;
  if (wishlist) {
    return (
      <WishlistFields
        mode={mode}
        replaces={values.replaces}
        choices={model.replaceable ?? []}
      />
    );
  }
  const orderItem =
    mode.kind === 'new' ? mode.destination.orderItem : undefined;
  return (
    <>
      {model.boughtFor && (
        // "Bought a different one" (#333): the save settles the need with
        // the garment, in its transaction (destination.ts, decide).
        <>
          <input
            type="hidden"
            name="forNeed"
            value={String(model.boughtFor.id)}
          />
          <p class="alert alert-info text-sm" id="garment-bought-for">
            {t('muse.BOUGHT_FOR', { need: model.boughtFor.name })}
          </p>
        </>
      )}
      {orderItem !== undefined && (
        // "Add to closet" from the order mail's review list (#25): the save
        // marks the order item added with the garment.
        <>
          <input type="hidden" name="orderItem" value={String(orderItem)} />
          <p class="alert alert-info text-sm" id="garment-order-item">
            {t('orders.FROM_ORDER')}
          </p>
        </>
      )}
      {/* The save writes the care fields only when this is posted (see GarmentBody.care). */}
      <input type="hidden" name="care" value="1" />
      <QuantityField value={values.care.quantity} errors={errors.quantity} />
    </>
  );
}

/**
 * The collapsed "More details": the other properties, washing, and the
 * closet's care, condition and acquired date (not on a wishlist form: those
 * come with "Bought it"), then the product link, price and notes.
 */
function MoreDetails(props: {
  model: GarmentFormModel;
  wishlist: boolean;
  category: string;
}) {
  const { model, wishlist, category } = props;
  const { values, errors = {} } = model;
  const { owner } = formAudience(model.mode, model.viewOwner);
  return (
    <details
      class="collapse collapse-arrow bg-base-200"
      open={moreDetailsOpen(model, wishlist)}
    >
      <summary class="collapse-title font-medium">{t('MORE_DETAILS')}</summary>
      <div class="collapse-content flex flex-col gap-4">
        <PropertiesMore category={category} values={values.properties} />
        {/* A wishlist item is not worn, washed or acquired yet: those
              fields come with "Bought it" and the closet's form. The wash
              limit is the owner's own record (formAudience). */}
        {!wishlist && owner && (
          <WashAfterField value={values.care.washAfterWears} />
        )}
        <TextArea
          name="washingDetails"
          label={t('WASHING_DETAILS')}
          value={values.washingDetails}
          placeholder={t('WASHING_DETAILS_PLACEHOLDER')}
        />
        {!wishlist && <ConditionFields care={values.care} />}
        {!wishlist && (
          <FormField
            id="garment-acquired"
            label={t('DATE_ACQUIRED')}
            messages={errors.dateAquired}
          >
            <input
              {...inputAttributes(
                'garment-acquired',
                'w-full',
                errors.dateAquired,
              )}
              type="date"
              name="dateAquired"
              value={values.dateAquired}
            />
          </FormField>
        )}
        {/* The save writes the two below only when this is posted (see GarmentBody.product). */}
        <input type="hidden" name="product" value="1" />
        <TextField
          name="sourceUrl"
          label={t('PRODUCT_LINK')}
          value={values.sourceUrl}
          maxlength={SOURCE_URL_MAX}
          placeholder={t('PRODUCT_LINK_PLACEHOLDER')}
          type="url"
          errors={errors.sourceUrl}
        />
        <TextField
          name="price"
          label={t('PRICE')}
          value={values.price}
          maxlength={PRICE_INPUT_MAX}
          placeholder={t('PRICE_PLACEHOLDER')}
          inputmode="decimal"
          errors={errors.price}
        />
        <TextArea
          name="notes"
          label={t('NOTES')}
          value={values.notes}
          placeholder={t('NOTES_PLACEHOLDER')}
        />
      </div>
    </details>
  );
}

/**
 * "More details" opens by default only when something inside needs
 * attention: a message, or what a link filled in there (materials, the
 * link, the price) for review; and always on a wishlist form, where the
 * product link and price are what the item is.
 */
function moreDetailsOpen(
  { errors = {}, link, values }: GarmentFormModel,
  wishlist: boolean,
): boolean {
  const refused = [errors.dateAquired, errors.sourceUrl, errors.price].some(
    (messages) => messages !== undefined,
  );
  const linkFilled = link !== undefined && values.sourceUrl !== '';
  return wishlist || refused || linkFilled;
}

/**
 * A wishlist form's own fields: its destination (a new one), and what it
 * replaces, with the marker the save reads it by (GarmentBody.wishlist).
 * The choices are the closet's garments, those that need replacing first.
 */
function WishlistFields(props: {
  mode: GarmentFormMode;
  replaces: string;
  choices: ReplaceableGarment[];
}) {
  const attention = props.choices.filter((g) => g.condition !== 'good');
  const rest = props.choices.filter((g) => g.condition === 'good');
  const option = (garment: ReplaceableGarment) => (
    <option
      value={String(garment.id)}
      selected={props.replaces === String(garment.id)}
    >
      {garment.name ?? categoryLabel(garment.category)}
      {garment.condition !== 'good' &&
        ` (${valueLabel('condition', garment.condition)})`}
    </option>
  );
  return (
    <>
      {props.mode.kind === 'new' && (
        <input type="hidden" name="to" value="wishlist" />
      )}
      <input type="hidden" name="wishlist" value="1" />
      <div class="flex flex-col">
        <label class="label" for="garment-replaces">
          <span class="label-text">{t('wishlist.REPLACES_LABEL')}</span>
        </label>
        <select
          id="garment-replaces"
          name="replaces"
          class="select select-bordered w-full"
        >
          <option value="" selected={props.replaces === ''}>
            {t('wishlist.REPLACES_NOTHING')}
          </option>
          {attention.length > 0 && (
            <optgroup label={t('wishlist.REPLACES_ATTENTION')}>
              {attention.map(option)}
            </optgroup>
          )}
          {rest.length > 0 && (
            <optgroup label={t('wishlist.REPLACES_OTHERS')}>
              {rest.map(option)}
            </optgroup>
          )}
        </select>
      </div>
    </>
  );
}

function TextField(props: {
  name: string;
  label: string;
  value: string;
  maxlength: number;
  placeholder: string;
  type?: 'text' | 'url';
  inputmode?: 'decimal';
  errors?: string[];
  /** htmx attributes a typed value sends somewhere (the brand's size hint). */
  refresh?: Record<string, string>;
}) {
  const id = `garment-${props.name}`;
  return (
    <FormField id={id} label={props.label} messages={props.errors}>
      <input
        {...inputAttributes(id, 'w-full', props.errors)}
        type={props.type ?? 'text'}
        inputmode={props.inputmode}
        name={props.name}
        value={props.value}
        maxlength={props.maxlength}
        placeholder={props.placeholder}
        {...props.refresh}
      />
    </FormField>
  );
}

/** Identical copies (three white tees): a number stepper, 1 to QUANTITY_MAX. */
function QuantityField(props: { value: string; errors?: string[] }) {
  return (
    <FormField
      id="garment-quantity"
      label={t('QUANTITY')}
      messages={props.errors}
    >
      <input
        {...inputAttributes('garment-quantity', 'w-28', props.errors)}
        type="number"
        name="quantity"
        min="1"
        max={QUANTITY_MAX}
        step="1"
        inputmode="numeric"
        value={props.value}
      />
      <span class="text-xs text-muted mt-1">{t('QUANTITY_HINT')}</span>
    </FormField>
  );
}

/** Wears before a wash: the category's default, a count, or never. */
function WashAfterField(props: { value: string }) {
  const options: { value: string; label: string }[] = [
    { value: '', label: t('WASH_AFTER_DEFAULT') },
    ...WASH_AFTER_CHOICES.map((wears) => ({
      value: String(wears),
      label:
        wears === 1
          ? t('WASH_AFTER_EVERY')
          : t('WASH_AFTER_WEARS', { count: wears }),
    })),
    { value: String(NEVER_WASH), label: t('WASH_AFTER_NEVER') },
  ];
  return (
    <div class="flex flex-col">
      <label class="label" for="garment-wash-after">
        <span class="label-text">{t('WASH_AFTER')}</span>
      </label>
      <select
        id="garment-wash-after"
        name="washAfterWears"
        class="select select-bordered w-full"
      >
        {options.map((option) => (
          <option value={option.value} selected={option.value === props.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The condition chips and what is wrong (kept only with a problem). */
function ConditionFields({ care }: { care: CareFormValues }) {
  return (
    <div class="flex flex-col gap-2">
      <span class="label">
        <span class="label-text">{t('CONDITION')}</span>
      </span>
      <div class="flex flex-wrap gap-2">
        {CONDITIONS.map((condition) => (
          <input
            type="radio"
            name="condition"
            value={condition}
            class="btn btn-sm rounded-full"
            aria-label={valueLabel('condition', condition)}
            checked={condition === care.condition}
          />
        ))}
      </div>
      <input
        type="text"
        name="conditionNote"
        value={care.conditionNote}
        maxlength={CARE_NOTE_MAX}
        placeholder={t('CONDITION_NOTE_PLACEHOLDER')}
        aria-label={t('CONDITION_NOTE')}
        class="input input-bordered w-full"
      />
    </div>
  );
}

function TextArea(props: {
  name: string;
  label: string;
  value: string;
  placeholder: string;
}) {
  const id = `garment-${props.name}`;
  return (
    <FormField id={id} label={props.label}>
      <textarea
        id={id}
        name={props.name}
        class="textarea textarea-bordered w-full"
        rows={3}
        maxlength={TEXT_MAX}
        placeholder={props.placeholder}
      >
        {props.value}
      </textarea>
    </FormField>
  );
}

/**
 * One checkbox per built-in colour (the form's `color` fields), inside a
 * searchable dropdown that public/js/color-multiselect.js enhances with
 * pills. Without the script it is still a working list of checkboxes. A
 * posted value outside the list (a hand-made request) is refused by the
 * server and named in the message, never rendered as an option.
 */
function ColorMultiSelect(props: { selected: string[]; errors?: string[] }) {
  const selected = new Set(props.selected);
  const count = GARMENT_COLORS.filter((color) => selected.has(color)).length;
  return (
    <div class="flex flex-col w-full min-w-0">
      <span class="label">
        <span class="label-text">{t('COLOR')}</span>
      </span>
      <details
        class="color-ms w-full min-w-0"
        data-placeholder={t('SELECT_COLOR')}
        data-selected-label={t('SELECTED')}
      >
        <summary>
          <span class="ms-pills">
            <span class="ms-placeholder">{t('SELECT_COLOR')}</span>
          </span>
          <svg
            class="ms-chevron"
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </summary>
        <div class="ms-dropdown-anchor">
          <div class="ms-dropdown">
            <div class="ms-search">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                class="ms-search-input"
                placeholder={t('SEARCH_COLORS')}
                aria-label={t('SEARCH_COLORS')}
                autocomplete="off"
              />
            </div>
            <div class="ms-options">
              {GARMENT_COLORS.map((color) => (
                <label class="ms-option">
                  <input
                    type="checkbox"
                    name="color"
                    value={color}
                    checked={selected.has(color)}
                  />
                  <span class={`ms-swatch ms-swatch--${color}`}></span>
                  <span class="capitalize">{color}</span>
                </label>
              ))}
            </div>
            <div class="ms-empty" hidden>
              {t('NO_MATCHES')}
            </div>
            <div class="ms-footer">
              <span class="ms-count">
                {count} {t('SELECTED')}
              </span>
              <button type="button" class="ms-clear">
                {t('CLEAR_ALL')}
              </button>
            </div>
          </div>
        </div>
      </details>
      <FieldMessages id="garment-color" messages={props.errors} />
    </div>
  );
}
