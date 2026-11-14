import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import { ListLimit, literals } from '../api/resource';
import { actorOf } from '../sharing/access';
import { coverageTable, READ_COVERAGE } from './coverage';
import { FEED, readChanges } from './feed';

/** A page of the feed unless asked: the most a page holds. */
const CHANGES_PAGE_SIZE = 100;

const ChangesQuery = Type.Object({
  cursor: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 4096,
      pattern: '^[A-Za-z0-9_-]+$',
      description:
        "The previous page's `cursor`, as it was answered to you; absent: everything, from the start",
    }),
  ),
  limit: ListLimit(CHANGES_PAGE_SIZE),
});

const entries = Object.values(FEED);

/** What every change and deletion says it is about. */
const about = {
  ownerId: Type.Integer({
    description: 'The wardrobe it belongs to: yours, or one shared with you',
  }),
  id: Type.Integer(),
  clientId: Type.Optional(
    Type.String({
      format: 'uuid',
      description: 'The id your create carried, when it carried one',
    }),
  ),
  revision: Type.Integer({
    description: "Its owner's revision when it was last written or deleted",
  }),
};

const Change = Type.Union(
  entries.map((entry) =>
    Type.Object({
      resource: Type.Literal(entry.name),
      ...about,
      data: entry.schema,
    }),
  ),
  { description: 'A row as it is now: create it, or replace yours whole' },
);

const Deletion = Type.Object(
  {
    resource: literals(entries.map((entry) => entry.name)),
    ...about,
  },
  {
    title: 'Deletion',
    description:
      'A row deleted: drop yours, or an unsent create with this `clientId`',
  },
);

const ChangesPage = Type.Object(
  {
    changes: Type.Array(Change),
    deletions: Type.Array(Deletion, {
      description: "Apply them before the page's changes",
    }),
    cursor: Type.String({
      description:
        'Where the next call resumes: send it as `cursor`, even when `more` is false',
    }),
    more: Type.Boolean({
      description: 'Whether another page is waiting now: call again at once',
    }),
    revokedWardrobes: Type.Optional(
      Type.Array(Type.Integer(), {
        description:
          'Owners in your cursor whose wardrobe you no longer see (a share revoked or left): drop their rows',
      }),
    ),
    snapshot: Type.Optional(
      Type.Object(
        {
          wardrobes: Type.Array(Type.Integer(), {
            description:
              'The wardrobes this full sync covers: yours, then each shared with you',
          }),
        },
        {
          description:
            'On every page of a full sync (one begun without a cursor), until the page where `more` is false. After that page, drop every synced row you were not sent during it, and every wardrobe not in its `wardrobes`: a full sync carries no deletions it has no need of, nor shares you lost. Your creates not yet sent stay',
        },
      ),
    ),
  },
  {
    title: 'ChangesPage',
    description:
      'Every row and deletion after the cursor, across your wardrobe and each one shared with you',
  },
);

/**
 * The changes feed on /api/v1 (#196b-1; src/web/sync/AGENTS.md): a native
 * client's sync. No page twin: the PWA reads pages, not rows. Shared
 * wardrobes come in through the cursor, never `?ownerId=` (a 400, as any
 * undeclared parameter).
 */
export const syncApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  { db, logger, cutouts },
  done,
) => {
  app.get(
    '/changes',
    {
      schema: {
        operationId: 'listChanges',
        tags: ['sync'],
        summary: 'What changed since your last sync',
        description: `Rows and deletions after \`cursor\`, oldest first, across your wardrobe and each one shared with you (its garments and capsules only). Apply each page's deletions, then its changes, then keep its \`cursor\`; call again while \`more\`. A 410 \`cursor_expired\` means the feed no longer holds what the cursor needs (a deletion older than 90 days was pruned), the cursor was answered to another account (a device that switched accounts), the feed has carried more since (a new resource), or the server's database was restored since: sync again from no cursor. A sync from no cursor is a full sync: its pages carry \`snapshot\`, and after its last one every synced row it did not send, and every wardrobe it did not list, is gone. The garment carries what is stored on it: a garment's wear counts and capsules are yours to derive from the wears and capsules. The style profile (with its outfit rules), the measurements and the week template are one per user, the change's \`id\` yours; the week template is never deleted, only emptied.

What the feed keeps fresh, and what you fetch online each time:

${coverageTable(READ_COVERAGE)}`,
        querystring: ChangesQuery,
        response: apiResponses({ 200: ChangesPage }),
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const page = await readChanges(
        db,
        actor,
        request.query.cursor,
        request.query.limit ?? CHANGES_PAGE_SIZE,
        cutouts.enabled,
      );
      if (page.revokedWardrobes.length > 0) {
        logger.debug(
          `Changes for user ${actor.userId}: wardrobes ${page.revokedWardrobes.join(', ')} no longer shared, dropped from the cursor`,
        );
      }
      const { revokedWardrobes, ...answer } = page;
      return revokedWardrobes.length > 0
        ? { ...answer, revokedWardrobes }
        : answer;
    },
  );

  done();
};
