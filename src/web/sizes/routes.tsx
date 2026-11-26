import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import { MEASUREMENTS } from '../../wardrobe/measurements';
import { sessionUserId } from '../auth/require-session';
import type { FieldErrors } from '../auth/validation';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage } from '../render';
import { RowId } from '../schemas';
import { actorOf } from '../sharing/access';
import { viewContext } from '../view-context';
import { brandSizeFor, brandSizesOf, findMeasurements } from './queries';
import {
  changeBrandSize,
  createBrandSize,
  removeBrandSize,
  saveBodyMeasurements,
  setBodyLengthUnit,
} from './size-actions';
import {
  BRAND_SIZE_HINT_PATH,
  BRAND_SIZES_PATH,
  SIZES_MEASUREMENTS_PATH,
  SIZES_PATH,
  SIZES_SAVED,
  SIZES_SAVED_FLAG,
  SIZES_UNIT_PATH,
  sizesSavedUrl,
} from './urls';
import {
  BrandSizeBody,
  type BrandSizeField,
  BrandSizeHintQuery,
  LengthUnitBody,
  measurementsPost,
  MeasurementsBody,
  readBrandSizeForm,
  readMeasurementsForm,
} from './validation';
import { BrandSizeHint, SizesPage, type SizesPageModel } from './views';

// The toast after a write: navigation state, anything else shows none.
const SizesQuery = Type.Object({
  [SIZES_SAVED_FLAG]: Type.Optional(Type.String()),
});

const BrandSizeParams = Type.Object({ id: RowId });

/**
 * Sizes (#24; plan section 16): Profile › Sizes' editor, its writes and
 * the garment form's brand hint. The signed-in user's own, like the style
 * profile: no route takes `?ownerId=`, and another user's brand row is a
 * 404. Every write is a native post answered 303 to the editor, or the
 * editor re-rendered 400 with the field's message. Validation: the unit is
 * one of LENGTH_UNITS and a row id an id (else 400, data a write stores);
 * the hint's brand is capped like the field.
 */
export const sizesRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, logger },
  done,
) => {
  /** The editor for `userId`, with what a refused post changes of it. */
  async function renderEditor(
    reply: FastifyReply,
    userId: number,
    change: Partial<SizesPageModel> = {},
    status = 200,
  ) {
    const [measurements, brands] = await Promise.all([
      findMeasurements(db, userId),
      brandSizesOf(db, userId),
    ]);
    return renderPage(
      reply,
      <SizesPage
        ctx={viewContext(reply)}
        model={{
          unit: measurements.unit,
          measurements: measurementsPost(
            measurements.lengths,
            measurements.unit,
          ),
          brands,
          ...change,
        }}
      />,
      { status },
    );
  }

  app.get(
    SIZES_PATH,
    { schema: { querystring: SizesQuery } },
    async (request, reply) => {
      const saved = request.query[SIZES_SAVED_FLAG];
      return renderEditor(reply, sessionUserId(request), {
        saved: SIZES_SAVED.find((flag) => flag === saved),
      });
    },
  );

  app.post(
    SIZES_UNIT_PATH,
    { schema: { body: LengthUnitBody } },
    async (request, reply) => {
      await setBodyLengthUnit(
        { db, logger },
        actorOf(request),
        request.body.unit,
      );
      return reply.redirect(SIZES_PATH, 303);
    },
  );

  app.post(
    SIZES_MEASUREMENTS_PATH,
    { schema: { body: MeasurementsBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { body } = request;
      const stored = await findMeasurements(db, userId);
      const form = readMeasurementsForm(body, stored.lengths);
      if (!form.ok) {
        return renderEditor(
          reply,
          userId,
          {
            // The numbers as typed, in the unit they were typed in.
            unit: body.unit,
            measurements: Object.fromEntries(
              MEASUREMENTS.map((m) => [m, body[m] ?? '']),
            ) as SizesPageModel['measurements'],
            measurementErrors: form.errors,
          },
          400,
        );
      }
      await saveBodyMeasurements(
        { db, logger },
        actorOf(request),
        form.lengths,
      );
      return reply.redirect(sizesSavedUrl('measurements'), 303);
    },
  );

  app.post(
    BRAND_SIZES_PATH,
    { schema: { body: BrandSizeBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { body } = request;
      const form = readBrandSizeForm(body);
      const refuse = (errors: FieldErrors<BrandSizeField>) =>
        renderEditor(
          reply,
          userId,
          { refusedBrand: { target: 'new', values: body, errors } },
          400,
        );
      if (!form.ok) return refuse(form.errors);
      const id = await createBrandSize(
        { db, logger },
        actorOf(request),
        form.fields,
      );
      if (id === 'brand-taken') {
        return refuse({ brand: [t('sizes.BRAND_TAKEN')] });
      }
      return reply.redirect(sizesSavedUrl('brand'), 303);
    },
  );

  app.post(
    `${BRAND_SIZES_PATH}/:id`,
    { schema: { params: BrandSizeParams, body: BrandSizeBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { id } = request.params;
      const { body } = request;
      const form = readBrandSizeForm(body);
      const refuse = (errors: FieldErrors<BrandSizeField>) =>
        renderEditor(
          reply,
          userId,
          { refusedBrand: { target: id, values: body, errors } },
          400,
        );
      if (!form.ok) return refuse(form.errors);
      const updated = await changeBrandSize(
        { db, logger },
        actorOf(request),
        id,
        form.fields,
      );
      if (updated === 'brand-taken') {
        return refuse({ brand: [t('sizes.BRAND_TAKEN')] });
      }
      return reply.redirect(sizesSavedUrl('brand'), 303);
    },
  );

  // Remove posts the row's own form (its button's formaction), so a body
  // arrives; it is not read.
  app.post(
    `${BRAND_SIZES_PATH}/:id/delete`,
    { schema: { params: BrandSizeParams } },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = request.params;
      await removeBrandSize({ db, logger }, actor, id);
      return reply.redirect(sizesSavedUrl('removed'), 303);
    },
  );

  // Always a fragment: the garment form's brand field asks it as it is
  // typed. The requester's own note, whatever wardrobe the form is for; the
  // form asks only on the requester's own wardrobe (garment-form.tsx).
  app.get(
    BRAND_SIZE_HINT_PATH,
    { schema: { querystring: BrandSizeHintQuery } },
    async (request, reply) => {
      const note = await brandSizeFor(
        db,
        sessionUserId(request),
        request.query.brand ?? '',
      );
      return renderFragment(reply, <BrandSizeHint note={note} />);
    },
  );

  done();
};
