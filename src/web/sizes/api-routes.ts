import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { MEASUREMENTS } from '../../wardrobe/measurements';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import { refusedBody } from '../api/refused-body';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { RowId } from '../schemas';
import { actorOf } from '../sharing/access';
import {
  addBrandSize,
  BRAND_TAKEN,
  addBrandSizeOnce,
  brandSizeFor,
  brandSizesOf,
  deleteBrandSize,
  findMeasurements,
  saveMeasurements,
  setLengthUnit,
  updateBrandSize,
} from './queries';
import {
  BrandSizeInput,
  NewBrandSize,
  BrandSizeQuery,
  BrandSizeResource,
  MeasurementsInput,
  MeasurementsResource,
  POINTER_OF_BRAND_FIELD,
  postedLengths,
  SizesResource,
  toBrandSizeResource,
  toMeasurementsResource,
  toSizesResource,
  UnitInput,
} from './sizes-resource';
import { readBrandSizeForm } from './validation';

const BrandSizeParams = Type.Object({ id: RowId });

const BrandSizeList = Type.Object(
  { data: Type.Array(BrandSizeResource) },
  {
    title: 'BrandSizeList',
    description: 'Your brand notes, by brand: never paged',
  },
);

const BRANDS_PATH = '/sizes/brands';

/** A brand already noted, as the page's form refuses it: under `brand`. */
const brandTaken = () =>
  refusedBody({ brand: [t('sizes.BRAND_TAKEN')] }, POINTER_OF_BRAND_FIELD);

/**
 * Sizes on /api/v1 (#588), each its page twin's read or writer
 * (operations.ts names the twin): the token's user's own, like Profile ›
 * Sizes, so no `?ownerId=` and another user's brand row is the writer's
 * 404. Measurements travel in centimetres, so the form's rule that a
 * length posted as shown keeps the stored one (readMeasurementsForm) has
 * nothing to guard here; a brand body is judged by the form's reader
 * (readBrandSizeForm), a refusal naming `body/<field>`. The logs name the
 * user and the row, never a length or a note.
 */
export const sizesApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  { db, logger },
  done,
) => {
  app.get(
    '/sizes',
    {
      schema: {
        operationId: 'getSizes',
        tags: ['sizes'],
        summary: 'Your measurements and brand sizes',
        description:
          "Profile › Sizes: your body measurements, the unit you read them in and the size you wear in each brand. Yours alone: a shared wardrobe never shows them, not even your own (they describe another body than its owner's).",
        response: apiResponses({ 200: SizesResource }),
      },
    },
    async (request) => {
      const userId = actorOf(request).userId;
      const [measurements, brands] = await Promise.all([
        findMeasurements(db, userId),
        brandSizesOf(db, userId),
      ]);
      return toSizesResource(measurements, brands);
    },
  );

  app.put(
    '/sizes/measurements',
    {
      schema: {
        operationId: 'saveMeasurements',
        tags: ['sizes'],
        summary: 'Saves your body measurements',
        description:
          'Every measurement at once, as the editor saves them: one absent or null is cleared. Set-state.',
        body: MeasurementsInput,
        response: apiResponses({ 200: MeasurementsResource }),
      },
    },
    async (request) => {
      const userId = actorOf(request).userId;
      const lengths = postedLengths(request.body);
      await saveMeasurements(db, userId, lengths);
      const set = MEASUREMENTS.filter((m) => lengths[m] !== null);
      logger.info(
        `Measurements saved by user ${userId} (API): ${set.length} of ${MEASUREMENTS.length} set`,
      );
      return toMeasurementsResource(lengths);
    },
  );

  app.put(
    '/sizes/unit',
    {
      schema: {
        operationId: 'setLengthUnit',
        tags: ['sizes'],
        summary: 'Sets how you read lengths',
        description:
          'Display only: every length here stays centimetres. Set-state.',
        body: UnitInput,
        response: apiResponses({ 200: UnitInput }),
      },
    },
    async (request) => {
      const userId = actorOf(request).userId;
      const { unit } = request.body;
      await setLengthUnit(db, userId, unit);
      logger.info(`Measurement unit set to ${unit} by user ${userId} (API)`);
      return { unit };
    },
  );

  app.get(
    BRANDS_PATH,
    {
      schema: {
        operationId: 'listBrandSizes',
        tags: ['sizes'],
        summary: 'Your brand sizes, or one brand’s',
        description:
          "The garment form's hint with `brand`: your note on that brand (none: an empty list), as you type it. Without, every note.",
        querystring: BrandSizeQuery,
        response: apiResponses({ 200: BrandSizeList }),
      },
    },
    async (request) => {
      const userId = actorOf(request).userId;
      const { brand } = request.query;
      if (brand === undefined) {
        const rows = await brandSizesOf(db, userId);
        return { data: rows.map(toBrandSizeResource) };
      }
      const row = await brandSizeFor(db, userId, brand);
      return { data: row ? [toBrandSizeResource(row)] : [] };
    },
  );

  app.post(
    BRANDS_PATH,
    {
      schema: {
        operationId: 'addBrandSize',
        tags: ['sizes'],
        summary: 'Notes your size in a brand',
        description:
          'A brand you have a note on already, in any case, is a 400 naming `body/brand`: change that one (PUT /sizes/brands/{id}). With a `clientId`, a retry answers the first note of that id (200, as it was saved) and creates nothing; the id of a note deleted since is a 410 `gone`.',
        body: NewBrandSize,
        response: apiResponses({
          200: BrandSizeResource,
          201: BrandSizeResource,
        }),
      },
    },
    async (request, reply) => {
      const userId = actorOf(request).userId;
      const { clientId, ...body } = request.body;
      const form = readBrandSizeForm(body);
      if (!form.ok) throw refusedBody(form.errors, POINTER_OF_BRAND_FIELD);
      const client = clientId ? `, client id ${clientId.slice(0, 8)}` : '';
      if (!clientId) {
        const id = await addBrandSize(db, userId, form.fields);
        if (id === BRAND_TAKEN) throw brandTaken();
        logger.info(`Brand size ${id} added by user ${userId} (API)`);
        return reply
          .status(201)
          .send(toBrandSizeResource({ id, ...form.fields }));
      }
      const added = await addBrandSizeOnce(db, userId, form.fields, clientId);
      if (added === BRAND_TAKEN) throw brandTaken();
      if (added === 'gone') throw new HttpError(410, t('sizes.BRAND_DELETED'));
      logger.info(
        `Brand size ${added.row.id} ${added.created ? 'added' : 'already added, retry answered'} by user ${userId} (API)${client}`,
      );
      // A retry answers the first row as stored, not this body: the id
      // names the create, not its content.
      return reply
        .status(added.created ? 201 : 200)
        .send(toBrandSizeResource(added.row));
    },
  );

  app.put(
    `${BRANDS_PATH}/:id`,
    {
      schema: {
        operationId: 'updateBrandSize',
        tags: ['sizes'],
        summary: 'Changes a brand note',
        description:
          'Replaced whole, as the editor saves a row. A brand another of your notes has is a 400 naming `body/brand`.',
        params: BrandSizeParams,
        body: BrandSizeInput,
        response: apiResponses({ 200: BrandSizeResource }),
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params;
      // As the page: the body is judged before the row, so a refused one is
      // the same 400 whoever's id it names.
      const form = readBrandSizeForm(request.body);
      if (!form.ok) throw refusedBody(form.errors, POINTER_OF_BRAND_FIELD);
      const updated = await updateBrandSize(db, actor, id, form.fields);
      if (updated === BRAND_TAKEN) throw brandTaken();
      logger.info(`Brand size ${id} changed by user ${actor.userId} (API)`);
      return toBrandSizeResource({ id, ...form.fields });
    },
  );

  app.delete(
    `${BRANDS_PATH}/:id`,
    {
      schema: {
        operationId: 'deleteBrandSize',
        tags: ['sizes'],
        summary: 'Removes a brand note',
        params: BrandSizeParams,
        response: apiResponses({ 204: Type.Null({ description: 'Removed' }) }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = request.params;
      await deleteBrandSize(db, actor, id);
      logger.info(`Brand size ${id} removed by user ${actor.userId} (API)`);
      return reply.status(204).send(null);
    },
  );

  done();
};
