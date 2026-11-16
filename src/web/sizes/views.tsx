import { cardClass } from '../card';
import {
  LENGTH_UNITS,
  type LengthUnit,
  type Measurement,
  MEASUREMENTS,
} from '../../wardrobe/measurements';
import { PostForm } from '../form';
import { profileSection } from '../auth/urls';
import type { FieldErrors } from '../auth/validation';
import { type StringKey, t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { FormField, inputAttributes } from '../form-field';
import { SavedToast, StripFlags } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { BRAND_MAX, SIZE_MAX } from '../wardrobe/garment-input';
import type { BrandSize } from './queries';
import {
  BRAND_SIZE_HINT_PATH,
  BRAND_SIZES_PATH,
  brandSizeUrl,
  SIZES_MEASUREMENTS_PATH,
  SIZES_SAVED_FLAG,
  SIZES_SECTION_ID,
  SIZES_UNIT_PATH,
  type SizesSaved,
} from './urls';
import {
  BRAND_NOTE_MAX,
  type BrandSizeBody,
  type BrandSizeField,
  LENGTH_INPUT_MAX,
} from './validation';
import { BRAND_SIZE_FIELDS, FIELD_GRID } from '../layout/columns';

/**
 * Sizes (#24; plan section 16): the editor (Profile › Sizes) and the brand
 * note other pages show. The signed-in user's own: the garment form
 * and the wishlist render a note only on the user's own wardrobe (never on a
 * shared one, where it would describe the wrong body).
 */

const HINT_ID = 'brand-size-hint';

/** "Sizes": the editor's title (Profile's row names it too). */
const SIZES_TITLE_KEY = 'sizes.TITLE' satisfies StringKey;

/** "Your size in Uniqlo: M · Runs big, never L"; "Uniqlo: Runs big" without a size. */
function brandSizeText(row: BrandSize): string {
  if (row.size === null) {
    return t('sizes.BRAND_NOTE', { brand: row.brand, note: row.note ?? '' });
  }
  const size = t('sizes.YOUR_SIZE', { brand: row.brand, size: row.size });
  return row.note === null ? size : `${size} · ${row.note}`;
}

/** The brand's note as a line of a card or a page (the wishlist). */
export function BrandSizeNote(props: {
  note: BrandSize | undefined;
  /** Its text size: the card's lines are text-xs. */
  size?: 'text-xs' | 'text-sm';
  /** On a card, two lines at most; the garment's page says it all. */
  clamp?: boolean;
}) {
  if (!props.note) return null;
  return (
    <p
      class={`${props.size ?? 'text-sm'} text-muted${props.clamp ? ' line-clamp-2' : ''}`}
      data-brand-size=""
    >
      {brandSizeText(props.note)}
    </p>
  );
}

/**
 * Under the garment form's Size: the note of the brand in the field, and
 * the slot the brand field refreshes (GET BRAND_SIZE_HINT_PATH answers
 * this, whole) as it is typed.
 */
export function BrandSizeHint(props: { note: BrandSize | undefined }) {
  return (
    <div id={HINT_ID} aria-live="polite">
      <BrandSizeNote note={props.note} />
    </div>
  );
}

/**
 * The brand field's refresh of the hint: a read (hx-get sends the field's
 * own value as `brand`), so not an autosave. Its own indicator keeps the
 * app bar's spinner still while typing.
 */
export const BRAND_SIZE_HINT_TRIGGER = {
  'hx-get': BRAND_SIZE_HINT_PATH,
  'hx-trigger': 'input changed delay:400ms',
  'hx-target': `#${HINT_ID}`,
  'hx-swap': 'outerHTML',
  'hx-indicator': `#${HINT_ID}`,
} as const;

export interface SizesPageModel {
  unit: LengthUnit;
  /** The measurement fields as shown: the stored ones, or what was posted. */
  measurements: Record<Measurement, string>;
  measurementErrors?: FieldErrors<Measurement>;
  brands: BrandSize[];
  /** A refused brand form: which (a row's id, or the new one), what was posted and why. */
  refusedBrand?: {
    target: number | 'new';
    values: BrandSizeBody;
    errors: FieldErrors<BrandSizeField>;
  };
  saved?: SizesSaved;
}

const SAVED_TOASTS = {
  measurements: 'sizes.saved.measurements',
  brand: 'sizes.saved.brand',
  removed: 'sizes.saved.removed',
} as const satisfies Record<SizesSaved, string>;

/**
 * GET /auth/profile/sizes, and its re-render with a refusal (400): the
 * unit, the measurements (one form, one Save: the numbers in the unit
 * shown), each brand's row and a new one. Native posts (PostForm): a
 * refusal re-renders the whole page with a 4xx.
 */
export function SizesPage(props: { ctx: ViewContext; model: SizesPageModel }) {
  const { ctx, model } = props;
  const refused = model.refusedBrand;
  return (
    <Layout ctx={ctx} title={t(SIZES_TITLE_KEY)}>
      <AppBar
        ctx={ctx}
        title={t(SIZES_TITLE_KEY)}
        back={profileSection(SIZES_SECTION_ID)}
        formPage
      />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto flex flex-col gap-6">
        <p class="text-sm text-muted">{t('sizes.HINT')}</p>
        <section
          class="flex flex-col gap-3"
          aria-labelledby="sizes-measurements-heading"
        >
          <div class="flex items-center justify-between gap-2">
            <h2 id="sizes-measurements-heading" class="text-lg font-semibold">
              {t('sizes.MEASUREMENTS')}
            </h2>
            <UnitSwitch unit={model.unit} />
          </div>
          <MeasurementsForm model={model} />
        </section>
        <section
          class="flex flex-col gap-3"
          aria-labelledby="sizes-brands-heading"
        >
          <h2 id="sizes-brands-heading" class="text-lg font-semibold">
            {t('sizes.BRANDS')}
          </h2>
          <p class="text-sm text-muted">{t('sizes.BRANDS_HINT')}</p>
          {model.brands.map((brand) =>
            refused?.target === brand.id ? (
              <BrandForm
                id={brand.id}
                values={refused.values}
                errors={refused.errors}
              />
            ) : (
              <BrandForm
                id={brand.id}
                values={{
                  brand: brand.brand,
                  size: brand.size ?? '',
                  note: brand.note ?? '',
                }}
              />
            ),
          )}
          <h3 class="font-medium">{t('sizes.ADD_BRAND')}</h3>
          <BrandForm
            values={
              refused?.target === 'new'
                ? refused.values
                : { brand: '', size: '', note: '' }
            }
            errors={refused?.target === 'new' ? refused.errors : undefined}
          />
        </section>
      </main>
      {model.saved && (
        <SavedToast id="sizes-toast" text={t(SAVED_TOASTS[model.saved])} />
      )}
      <StripFlags names={[SIZES_SAVED_FLAG]} />
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * The unit, apart from the measurements' form: switching it shows the same
 * lengths converted, so a number typed in one unit is never read in the
 * other.
 */
function UnitSwitch({ unit }: { unit: LengthUnit }) {
  return (
    <PostForm action={SIZES_UNIT_PATH} class="join">
      {LENGTH_UNITS.map((choice) => (
        <button
          type="submit"
          name="unit"
          value={choice}
          class={`btn btn-sm join-item ${choice === unit ? 'btn-active' : ''}`}
          aria-pressed={choice === unit ? 'true' : 'false'}
          aria-label={t(`sizes.unitName.${choice}`)}
        >
          {t(`sizes.unit.${choice}`)}
        </button>
      ))}
    </PostForm>
  );
}

function MeasurementsForm({ model }: { model: SizesPageModel }) {
  const errors = model.measurementErrors ?? {};
  const unit = t(`sizes.unit.${model.unit}`);
  return (
    <PostForm action={SIZES_MEASUREMENTS_PATH} class="flex flex-col gap-3">
      {/* The unit the numbers are shown in, which is how they are read. */}
      <input type="hidden" name="unit" value={model.unit} />
      <div class={FIELD_GRID}>
        {MEASUREMENTS.map((m) => {
          const id = `measurement-${m}`;
          // The unit sits inside the frame, so the frame takes the classes
          // and the input inside it the id and aria.
          const { class: frame, ...control } = inputAttributes(
            id,
            'w-full',
            errors[m],
          );
          return (
            <FormField
              id={id}
              label={t(`sizes.measurement.${m}`)}
              messages={errors[m]}
            >
              <label class={frame}>
                <input
                  {...control}
                  type="text"
                  inputmode="decimal"
                  name={m}
                  value={model.measurements[m]}
                  maxlength={LENGTH_INPUT_MAX}
                />
                <span class="text-muted">{unit}</span>
              </label>
            </FormField>
          );
        })}
      </div>
      <button type="submit" class="btn btn-primary">
        {t('sizes.SAVE_MEASUREMENTS')}
      </button>
    </PostForm>
  );
}

/** A brand's row (with `id`) or the new one: brand, size, note, Save and Remove. */
function BrandForm(props: {
  id?: number;
  values: BrandSizeBody;
  errors?: FieldErrors<BrandSizeField>;
}) {
  const { id, values, errors = {} } = props;
  const prefix = `brand-size-${id ?? 'new'}`;
  return (
    <PostForm
      action={id === undefined ? BRAND_SIZES_PATH : brandSizeUrl(id)}
      class={cardClass('inset', 'card-body p-3 gap-2')}
    >
      <div class={BRAND_SIZE_FIELDS}>
        <BrandInput
          id={`${prefix}-brand`}
          name="brand"
          label={t('BRAND')}
          value={values.brand}
          maxlength={BRAND_MAX}
          placeholder={t('BRAND_PLACEHOLDER')}
          errors={errors.brand}
          required
        />
        <BrandInput
          id={`${prefix}-size`}
          name="size"
          label={t('SIZE')}
          value={values.size ?? ''}
          maxlength={SIZE_MAX}
          placeholder={t('sizes.SIZE_PLACEHOLDER')}
          errors={errors.size}
        />
      </div>
      <BrandInput
        id={`${prefix}-note`}
        name="note"
        label={t('sizes.NOTE')}
        value={values.note ?? ''}
        maxlength={BRAND_NOTE_MAX}
        placeholder={t('sizes.NOTE_PLACEHOLDER')}
        errors={errors.note}
      />
      <div class="flex gap-2 justify-end">
        {id !== undefined && (
          // The same native form, posted to the delete route instead.
          <button
            type="submit"
            class="btn btn-ghost btn-sm"
            formaction={brandSizeUrl(id, 'delete')}
            formnovalidate
            aria-label={t('sizes.REMOVE_BRAND_LABEL', { brand: values.brand })}
          >
            {t('sizes.REMOVE_BRAND')}
          </button>
        )}
        <button type="submit" class="btn btn-primary btn-sm">
          {id === undefined ? t('sizes.ADD') : t('SAVE')}
        </button>
      </div>
    </PostForm>
  );
}

function BrandInput(props: {
  id: string;
  name: BrandSizeField;
  label: string;
  value: string;
  maxlength: number;
  placeholder: string;
  errors?: string[];
  required?: boolean;
}) {
  return (
    <FormField id={props.id} label={props.label} messages={props.errors}>
      <input
        {...inputAttributes(props.id, 'input-sm w-full', props.errors)}
        type="text"
        name={props.name}
        value={props.value}
        maxlength={props.maxlength}
        placeholder={props.placeholder}
        required={props.required}
      />
    </FormField>
  );
}
