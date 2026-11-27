import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { type FastifyReply, type FastifyRequest } from 'fastify';
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
import { actorOf, sharedWardrobesOf, wardrobeGuard } from '../sharing/access';
import { viewContext } from '../view-context';
import { garmentAddress, garmentNotFound } from '../wardrobe/garment-access';
import { garmentUrl, LAUNDRY_PATH, laundryUrl } from '../wardrobe/urls';
import { CARE_NOTE_MAX } from '../wardrobe/garment-input';
import { LaundryPage } from './laundry-page';
import { laundryList, wearStatusOf } from './queries';
import {
  putGarmentAway,
  washGarment,
  washGarments,
  WearClientIdRefusal,
  wearGarment,
  type WearWrite,
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
  ...OwnerQuery.properties,
  // One-shot flag from POST /laundry's redirect (the toast).
  washed: Type.Optional(Type.Integer({ minimum: 0 })),
});

/**
 * Wears, washes and away (docs/plans/2026-09-26-wardrobe-features.md,
 * section 1): the garment page's Wore today, Washed and "where is it", and
 * /laundry. Wore today, Washed and the laundry are `launder` (#680): the
 * owner's and a MANAGE partner's, through `?ownerId=`; away is the owner's
 * alone. A grantee without what a route needs is refused (403 with
 * `?ownerId=`, where they can see the wardrobe; 404 without, where the
 * garment is not in their wardrobe), each by its domain function
 * (wear-actions.ts). The calendar's worn pill is POST /calendar/:id/worn
 * (setEntryWorn, the same query layer), the owner's like the calendar.
 */
export const wearRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger },
  done,
) => {
  const deps = { db, logger };
  const today = () => todayIn(config.timeZone, new Date());
  const authorize = wardrobeGuard(db, 'wardrobe');

  /**
   * A replay's 204 (src/web/offline-writes.ts); the wear status again to
   * htmx, with what the tap did said in the status region (#679); the
   * garment page to a plain post. `after` is the tap's control, which the
   * answer keeps focused (WearStatus).
   */
  async function answer(
    request: FastifyRequest,
    reply: FastifyReply,
    id: number,
    write: WearWrite,
    result: { message: string; after: WearTap },
  ): Promise<FastifyReply> {
    const { access, viewOwner } = write.wardrobe;
    if (isReplay(request)) return answerReplay(reply, write.changed);
    if (!request.headers['hx-request']) {
      return reply.redirect(garmentUrl(id, viewOwner), 303);
    }
    const day = today();
    const status = await wearStatusOf(db, id, access, day);
    if (!status) throw garmentNotFound();
    announce(reply, result.message);
    return renderFragment(
      reply,
      <WearStatus
        garment={status.garment}
        panel={{
          laundry: status.laundry,
          record: status.record,
          viewOwner,
          answeredOn: day,
        }}
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
      const write = await wearGarment(
        deps,
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
      return answer(request, reply, id, write, {
        message: worn
          ? t('wear.status.WORE_TODAY')
          : t('wear.status.WORE_TODAY_UNDONE'),
        after: 'wear',
      });
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
      const write = await washGarment(
        deps,
        actorOf(request),
        garmentAddress(request),
        { day, at },
      );
      return answer(request, reply, id, write, {
        message: t('wear.status.WASHED'),
        after: 'wash',
      });
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
      await putGarmentAway(
        deps,
        actorOf(request),
        garmentAddress(request),
        away === '' ? null : { reason: away, note: awayNote?.trim() || null },
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
  // (PostForm). `?ownerId=` is a MANAGE partner's view of the owner's
  // hamper (`launder`; a VIEW grantee is a 403).
  app.get(
    LAUNDRY_PATH,
    { schema: { querystring: LaundryQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await authorize(request, 'launder');
      const [items, sharedWardrobes] = await Promise.all([
        laundryList(db, access.ownerId),
        sharedWardrobesOf(db, actorOf(request)),
      ]);
      return renderPage(
        reply,
        <LaundryPage
          ctx={viewContext(reply)}
          items={items}
          viewOwner={viewOwner}
          canEdit={access.canManage}
          sharedWardrobes={sharedWardrobes}
          washed={request.query.washed}
        />,
      );
    },
  );

  // "Mark washed": every checked garment of the wardrobe's, today; other
  // ids are ignored like unknown ones. Back to the page with the count.
  app.post(
    LAUNDRY_PATH,
    { schema: { querystring: OwnerQuery, body: LaundryBody } },
    async (request, reply) => {
      const ids = request.body?.ids ?? [];
      const day = today();
      // The redirect's wardrobe; washGarments' own check is then free.
      const { access, viewOwner } = await authorize(request, 'launder');
      const { washed } = await washGarments(
        deps,
        actorOf(request),
        access.ownerId,
        ids,
        { day, at: postedInstant(request, undefined, day, config.timeZone) },
      );
      return reply.redirect(
        laundryUrl(viewOwner, { washed: washed.length }),
        303,
      );
    },
  );

  done();
};
