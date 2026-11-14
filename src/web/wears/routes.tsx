import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AWAY_REASONS } from '../../wardrobe/availability';
import { sessionUserId } from '../auth/require-session';
import { announce } from '../announce';
import { AutosaveSaved } from '../autosave';
import { todayIn } from '../../calendar-date';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage } from '../render';
import {
  answerReplay,
  instantNote,
  isReplay,
  postedInstant,
  replayNote,
  requestedDay,
} from '../offline-writes';
import {
  GarmentParams,
  IsoDateSchema,
  OwnerQuery,
  RowId,
  TapInstantSchema,
} from '../schemas';
import { actorOf, sharedWardrobesOf } from '../sharing/access';
import { viewContext } from '../view-context';
import { garmentAddress, garmentNotFound } from '../wardrobe/garment-access';
import { garmentUrl, LAUNDRY_PATH } from '../wardrobe/urls';
import { CARE_NOTE_MAX } from '../wardrobe/garment-input';
import { LaundryPage } from './laundry-page';
import { laundryList, markWashed, wearStatusOf } from './queries';
import {
  putGarmentAway,
  washGarment,
  WearClientIdRefusal,
  wearGarment,
} from './wear-actions';
import { WearStatus, type WearTap } from './wear-section';

// `day` is a queued tap's own day (#178), else today: requestedDay
// refuses one outside the replay window (409).
const WoreTodayBody = Type.Object({
  worn: Type.Union([Type.Literal('1'), Type.Literal('0')]),
  day: Type.Optional(IsoDateSchema),
  // The tap's instant (#676), for a same-day wash's order: postedInstant.
  at: Type.Optional(TapInstantSchema),
  // A queued wear's id (the outbox record's), stored on the wear it
  // creates (setWoreToday): a replay of a wear deleted since is a 410,
  // the id on another wear a 409. Ignored with worn=0.
  clientId: Type.Optional(Type.String({ format: 'uuid' })),
});

const WashedBody = Type.Union([
  Type.Object({
    day: Type.Optional(IsoDateSchema),
    at: Type.Optional(TapInstantSchema),
  }),
  Type.Null(),
]);

const AwayBody = Type.Object({
  // '' is back in the closet.
  away: Type.Union([
    Type.Literal(''),
    ...AWAY_REASONS.map((reason) => Type.Literal(reason)),
  ]),
  awayNote: Type.Optional(Type.String({ maxLength: CARE_NOTE_MAX })),
});

const LaundryBody = Type.Union([
  Type.Object({ ids: Type.Optional(Type.Array(RowId, { maxItems: 2000 })) }),
  Type.Null(),
]);

const LaundryQuery = Type.Object({
  // One-shot flag from POST /laundry's redirect (the toast).
  washed: Type.Optional(Type.Integer({ minimum: 0 })),
});

/**
 * Wears, washes and away (docs/plans/2026-09-26-wardrobe-features.md,
 * section 1): the garment page's Wore today, Washed and "where is it", and
 * /laundry. The owner's own records, like outfits and the calendar: a
 * garment in a shared wardrobe is refused to a grantee (403 with
 * `?ownerId=`, where they can see it; 404 without, where it is not in
 * their wardrobe), and /laundry is always the signed-in user's own
 * (`?ownerId=` ignored). The calendar's worn pill is POST /calendar/:id/worn
 * (setEntryWorn, the same query layer).
 */
export const wearRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger },
  done,
) => {
  const today = () => todayIn(config.timeZone, new Date());

  /**
   * A replay's 204 (src/web/offline-writes.ts); the wear status again to
   * htmx, with what the tap did said in the status region (#679); the
   * garment page to a plain post. `after` is the tap's control, which the
   * answer keeps focused (WearStatus).
   */
  async function answer(
    request: FastifyRequest,
    reply: FastifyReply,
    write: { id: number; ownerId: number; changed: boolean },
    result: { message: string; after: WearTap },
  ): Promise<FastifyReply> {
    const { id, ownerId } = write;
    if (isReplay(request)) return answerReplay(reply, write.changed);
    if (!request.headers['hx-request']) {
      return reply.redirect(garmentUrl(id, undefined), 303);
    }
    const day = today();
    const status = await wearStatusOf(db, id, ownerId, day);
    if (!status) throw garmentNotFound();
    announce(reply, result.message);
    return renderFragment(
      reply,
      <WearStatus
        garment={status.garment}
        panel={{ summary: status.summary, answeredOn: day }}
        after={result.after}
      />,
    );
  }

  // Wore today (worn=1) and its undo the same day (worn=0). Queueable
  // (#178): last write wins, so a replayed undo after a wear unwears.
  app.post(
    '/wardrobe/:id/wear',
    {
      config: { queueable: 'wear' },
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: WoreTodayBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const worn = request.body.worn === '1';
      const day = requestedDay(reply, request.body.day, today());
      const { clientId } = request.body;
      const { ownerId, changed } = await wearGarment(
        db,
        actorOf(request),
        garmentAddress(request),
        {
          day,
          worn,
          wornAt: postedInstant(request, request.body.at, day, config.timeZone),
          clientId: worn ? clientId : undefined,
        },
      ).catch((error: unknown) => {
        if (error instanceof WearClientIdRefusal) {
          logger.info(
            `Garment ${id} wear on ${day} by user ${sessionUserId(request)} refused: client id ${clientId!.slice(0, 8)} ${error.outcome === 'gone' ? 'was deleted' : 'names another wear'}${replayNote(request)}`,
          );
        }
        throw error;
      });
      logger.info(
        `Garment ${id} ${worn ? 'worn' : 'wear undone'} on ${day} by user ${ownerId}${changed ? '' : ', already so'}${replayNote(request)}`,
      );
      return answer(
        request,
        reply,
        { id, ownerId, changed },
        {
          message: worn
            ? t('wear.status.WORE_TODAY')
            : t('wear.status.WORE_TODAY_UNDONE'),
          after: 'wear',
        },
      );
    },
  );

  // Queueable (#178); a wash only moves forward (markWashed), so a late
  // replay of an older one is `unchanged`.
  app.post(
    '/wardrobe/:id/washed',
    {
      config: { queueable: 'wash' },
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: WashedBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const day = requestedDay(reply, request.body?.day, today());
      const at = postedInstant(request, request.body?.at, day, config.timeZone);
      const { ownerId, changed } = await washGarment(
        db,
        actorOf(request),
        garmentAddress(request),
        { day, at },
      );
      logger.info(
        `Garment ${id} washed on ${day} ${instantNote(at)} by user ${ownerId}${changed ? '' : ', already washed then or later'}${replayNote(request)}`,
      );
      return answer(
        request,
        reply,
        { id, ownerId, changed },
        { message: t('wear.status.WASHED'), after: 'wash' },
      );
    },
  );

  app.post(
    '/wardrobe/:id/away',
    {
      schema: {
        params: GarmentParams,
        querystring: OwnerQuery,
        body: AwayBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { away, awayNote } = request.body;
      const { ownerId } = await putGarmentAway(
        db,
        actorOf(request),
        garmentAddress(request),
        away === '' ? null : { reason: away, note: awayNote?.trim() || null },
      );
      logger.info(
        `Garment ${id} ${away === '' ? 'back in the closet' : `away (${away})`} for user ${ownerId}`,
      );
      // "Where it is" is an AutosaveForm: its status line, never the form.
      if (!request.headers['hx-request']) {
        return reply.redirect(garmentUrl(id, undefined), 303);
      }
      return renderFragment(reply, <AutosaveSaved />);
    },
  );

  // The laundry page, the Wardrobe's Laundry tab: what needs a wash
  // (checked) and what was worn but is not due yet, as one native form
  // (PostForm).
  app.get(
    LAUNDRY_PATH,
    { schema: { querystring: LaundryQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const [items, sharedWardrobes] = await Promise.all([
        laundryList(db, userId),
        sharedWardrobesOf(db, actorOf(request)),
      ]);
      return renderPage(
        reply,
        <LaundryPage
          ctx={viewContext(reply)}
          items={items}
          sharedWardrobes={sharedWardrobes}
          washed={request.query.washed}
        />,
      );
    },
  );

  // "Mark washed": every checked garment of the user's, today; other ids
  // are ignored like unknown ones. Back to the page with the count.
  app.post(
    LAUNDRY_PATH,
    { schema: { body: LaundryBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const ids = request.body?.ids ?? [];
      const day = today();
      const washed = await markWashed(
        db,
        userId,
        ids,
        day,
        postedInstant(request, undefined, day, config.timeZone),
      );
      logger.info(
        `Laundry by user ${userId} on ${day}: ${washed.length} washed of ${ids.length} checked`,
      );
      return reply.redirect(`${LAUNDRY_PATH}?washed=${washed.length}`, 303);
    },
  );

  done();
};
