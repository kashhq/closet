import { GARMENT_COLORS } from '../../wardrobe/properties';
import { BUDGET_BANDS, STYLES } from '../../wardrobe/style';
import type { RhythmEntry } from '../../wardrobe/week';
import { PostForm } from '../form';
import { profileSection, STYLE_SECTION_ID } from '../auth/urls';
import { occasionLabel } from '../date-labels';
import { ChipGroup } from '../form-field';
import { type StringKey, t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { SavedToast, StripFlags } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { WEEK_SETTINGS_PATH } from '../week-plan/urls';
import { budgetLabel, styleLabel } from './labels';
import { OutfitRulesSection, type OutfitRulesModel } from './outfit-rules';
import { STYLE_PROFILE_PATH, STYLE_SAVED_FLAG, type StyleSaved } from './urls';
import { WEATHER_SETTINGS_PATH } from '../weather/urls';
import { STYLE_NOTES_MAX, type StyleProfileBody } from './validation';

export interface StyleProfileModel {
  /** The form's values: the stored profile's (styleProfilePost). */
  values: StyleProfileBody;
  saved?: StyleSaved;
  /**
   * The week's rhythm, derived from the week template (#16, weeklyRhythm):
   * shown read-only, set in Profile › Your week, never stored here.
   */
  rhythm: RhythmEntry[];
  /**
   * The weather's home city (#14), shown read-only: set and changed in
   * Profile › Weather, never stored here. Undefined with the weather off.
   */
  home?: { name: string | null };
  /** The Outfit rules section (#21b), below the profile's form. */
  rules: OutfitRulesModel;
}

const SAVED_TOASTS = {
  profile: 'style.SAVED',
  'rule-added': 'style.RULE_ADDED',
  'rule-removed': 'style.RULE_REMOVED',
  'pair-allowed': 'style.PAIR_ALLOWED',
} as const satisfies Record<StyleSaved, StringKey>;

/**
 * GET /auth/profile/style: the signed-in user's style profile (#34, slice
 * 34a), a section of the Profile (docs/plans/2026-09-26-redesign.md):
 * styles, the budget band, the palette, and the week's rhythm read-only:
 * it is the week template's (#16, Profile › Your week), counted per
 * calendar occasion. Private: nobody else ever sees it. The home city
 * belongs to the weather (#14): shown here read-only too, linking to
 * Profile › Weather to change it. Below the form, the owner's outfit
 * rules (#21b, OutfitRulesSection), forms of their own.
 */
export function StyleProfilePage(props: {
  ctx: ViewContext;
  model: StyleProfileModel;
}) {
  const { ctx, model } = props;
  const { values } = model;
  return (
    <Layout ctx={ctx} title={t('style.TITLE')}>
      <AppBar
        ctx={ctx}
        title={t('style.TITLE')}
        back={profileSection(STYLE_SECTION_ID)}
        formPage
      />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto">
        <p class="text-sm text-muted mb-4">{t('style.INTRO')}</p>
        {model.home && <HomeCity name={model.home.name} />}
        <PostForm action={STYLE_PROFILE_PATH} class="flex flex-col gap-5">
          <ChipGroup label={t('style.STYLES')}>
            {STYLES.map((style) => (
              <input
                type="checkbox"
                name="styles"
                value={style}
                class="btn btn-sm rounded-full"
                aria-label={styleLabel(style)}
                checked={values.styles?.includes(style)}
              />
            ))}
          </ChipGroup>
          <ChipGroup label={t('style.BUDGET')} hint={t('style.BUDGET_HINT')}>
            <input
              type="radio"
              name="budget"
              value=""
              class="btn btn-sm btn-ghost rounded-full"
              aria-label={t('NOT_SET')}
              checked={!values.budget}
            />
            {BUDGET_BANDS.map((band) => (
              <input
                type="radio"
                name="budget"
                value={band}
                class="btn btn-sm rounded-full"
                aria-label={budgetLabel(band)}
                checked={values.budget === band}
              />
            ))}
          </ChipGroup>
          <ChipGroup label={t('style.PALETTE')}>
            {GARMENT_COLORS.map((color) => (
              <input
                type="checkbox"
                name="palette"
                value={color}
                class="btn btn-sm rounded-full"
                aria-label={color}
                checked={values.palette?.includes(color)}
              />
            ))}
          </ChipGroup>
          <WeekRhythm rhythm={model.rhythm} />
          <div class="flex flex-col">
            <label class="label" for="style-notes">
              <span class="label-text">{t('NOTES')}</span>
            </label>
            <textarea
              id="style-notes"
              name="notes"
              class="textarea textarea-bordered w-full"
              rows={3}
              maxlength={STYLE_NOTES_MAX}
              placeholder={t('style.NOTES_PLACEHOLDER')}
            >
              {values.notes ?? ''}
            </textarea>
          </div>
          <button type="submit" class="btn btn-primary">
            {t('SAVE')}
          </button>
        </PostForm>
        <OutfitRulesSection model={model.rules} />
      </main>
      {model.saved && (
        <SavedToast id="style-toast" text={t(SAVED_TOASTS[model.saved])} />
      )}
      <StripFlags names={[STYLE_SAVED_FLAG]} />
      <Dock ctx={ctx} />
    </Layout>
  );
}

/** The weather's home city, and where to change it (Profile › Weather). */
function HomeCity({ name }: { name: string | null }) {
  return (
    <p class="text-sm mb-4" id="style-home">
      {name === null ? (
        <a class="link link-primary" href={WEATHER_SETTINGS_PATH}>
          {t('weather.SET_LOCATION')}
        </a>
      ) : (
        <>
          {t('weather.HOME_IS', { name })}{' '}
          <a class="link link-primary" href={WEATHER_SETTINGS_PATH}>
            {t('style.CHANGE_HOME')}
          </a>
        </>
      )}
    </p>
  );
}

/**
 * The week's rhythm ("Work 3× a week"), derived from the week template, and
 * where to change it: the Profile's Your week (#16).
 */
function WeekRhythm({ rhythm }: { rhythm: RhythmEntry[] }) {
  return (
    <div class="flex flex-col" id="style-rhythm">
      <span class="label">
        <span class="label-text">{t('style.WEEK')}</span>
      </span>
      {rhythm.length === 0 ? (
        <p class="text-sm">
          {t('style.WEEK_NONE')}{' '}
          <a class="link link-primary" href={WEEK_SETTINGS_PATH}>
            {t('style.WEEK_EDIT')}
          </a>
        </p>
      ) : (
        <>
          <ul class="text-sm flex flex-wrap gap-x-3 gap-y-1">
            {rhythm.map(({ occasion, perWeek }) => (
              <li data-occasion={occasion}>
                {t('style.WEEK_RHYTHM', {
                  occasion: occasionLabel(occasion),
                  count: perWeek,
                })}
              </li>
            ))}
          </ul>
          <a class="link link-primary text-sm mt-1" href={WEEK_SETTINGS_PATH}>
            {t('style.WEEK_CHANGE')}
          </a>
        </>
      )}
    </div>
  );
}
