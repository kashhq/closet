import { type Static, Type } from '@sinclair/typebox';
import { type AnyColumn, sql, type SQL } from 'drizzle-orm';
import { personalAccessToken, user } from '../db/schema';
import { t } from './i18n';

/**
 * Who made a write (#682): the person (a page, /api/v1 with a device token)
 * or the owner's agent over MCP, by its token's row id. A required argument
 * of every writer that stamps a row with it (the calendar's entries, a
 * trip's outfits, outfits, garments), so a caller that forgets it fails to
 * compile; MCP builds it with `originOf(ctx)` (src/web/mcp/tool.ts), every
 * other surface passes BY_PERSON. Which tools stamp what is MCP_WRITES'
 * `attribution` (src/web/api/operations.ts).
 */
export interface WriteOrigin {
  agentTokenId: number | null;
}

export const BY_PERSON: WriteOrigin = Object.freeze({ agentTokenId: null });

/**
 * A stamped row's agent as one viewer may see it, null for the person's:
 * the viewer rule already applied in SQL (`agentLabelSql`), so no reader
 * ever holds the token's author or the name of a token that is not the
 * viewer's. Only `agentName` turns it into words.
 */
export type AgentLabel =
  /** The viewer's own token, by its name. */
  | { readonly kind: 'token'; readonly name: string }
  /** A grantee's agent on the viewer's own wardrobe, by the grantee's first name. */
  | { readonly kind: 'person'; readonly firstName: string }
  /** Anyone else's, or one whose token or author is gone. */
  | { readonly kind: 'anonymous' };

/** Who reads the row: themselves, and whether the wardrobe is theirs. */
export interface AgentViewer {
  viewerId: number;
  /** True, or the row's `owner_id = viewer` (a feed page spans wardrobes). */
  ownsWardrobe: SQL | boolean;
}

/**
 * agentLabelSql's viewer for the rows only their owner reads (calendar
 * entries, trips, outfits): only the owner's own tokens write there, so
 * the reader is the token's author.
 */
export const OWNER_READS = 'owner-reads';

/**
 * The agent behind `tokenColumn` as `viewer` may see it (AgentLabel), the
 * one rule every surface answers (pages, /api/v1, the changes feed, MCP):
 * the token's own user sees its name; the wardrobe's owner sees whose agent
 * it was by first name (a grantee's on their wardrobe), never an email;
 * anyone else, and anyone once the token or its author is gone, "Agent".
 * One scalar subquery inside the reader's own statement, never a statement
 * of its own. `madeByAgent` says the row is an agent's even with no token
 * left (outfit_calendar's `planned_by = 'agent'` after a set null); without
 * it a non-null id is the mark (the garment's soft reference, and the
 * suggestion rows, which can have none: museName). Rows only their owner
 * reads, written only by the owner's tokens, take `OWNER_READS`. The only
 * reader of a token's name outside the token list (personal-tokens.ts).
 */
export function agentLabelSql(
  tokenColumn: AnyColumn | SQL,
  viewer: AgentViewer | typeof OWNER_READS,
  madeByAgent: SQL = sql`${tokenColumn} is not null`,
): SQL<AgentLabel | null> {
  const seen =
    viewer === OWNER_READS
      ? sql`json_build_object('kind', 'token', 'name', stamp_token.name)`
      : sql`case
          when stamp_token.user_id = ${viewer.viewerId}::int
            then json_build_object('kind', 'token', 'name', stamp_token.name)
          when ${ownsWardrobeSql(viewer.ownsWardrobe)} and nullif(stamp_author.first_name, '') is not null
            then json_build_object('kind', 'person', 'firstName', stamp_author.first_name)
        end`;
  // Aliased by hand: in a single-table select Drizzle writes columns
  // without their table (src/db/AGENTS.md), and the token's `name` would
  // then read as the outer row's.
  return sql<AgentLabel | null>`case when ${madeByAgent} then coalesce((
    select ${seen}
    from ${personalAccessToken} stamp_token
    inner join ${user} stamp_author on stamp_author.id = stamp_token.user_id
    where stamp_token.id = ${tokenColumn}
  ), json_build_object('kind', 'anonymous')) end`;
}

function ownsWardrobeSql(owns: SQL | boolean): SQL {
  return typeof owns === 'boolean' ? sql`${owns}::boolean` : owns;
}

/** The label in words: the token's name, "Dana’s agent", or "Agent". */
export function agentName(label: AgentLabel): string {
  switch (label.kind) {
    case 'token':
      return label.name;
    case 'person':
      return t('agent.OF_PERSON', { name: label.firstName });
    case 'anonymous':
      return t('agent.ANONYMOUS');
  }
}

/**
 * The suggestion agent's rows (needs, suggestions, proposals, rounds) as
 * their pages word them mid-sentence: the label, or "your agent" for one no
 * token made (drizzle/0040's migrated plan candidates). A sentence-initial
 * use has its own `_UNNAMED` key instead (roundCard, Today's needs card).
 */
export function museName(label: AgentLabel | null): string {
  return label ? agentName(label) : t('muse.AGENT');
}

/** agentName for an answer's optional field (MCP): absent on the person's rows. */
export function agentNameOf(
  label: AgentLabel | null | undefined,
): string | undefined {
  return label ? agentName(label) : undefined;
}

/** The API's and the changes feed's `agent` field: present only on what an agent made. */
export const AgentResource = Type.Object(
  {
    name: Type.String({
      description:
        'Your token\'s name when it was yours, "<first name>\'s agent" for a grantee\'s agent on your wardrobe, else "Agent"',
    }),
  },
  {
    title: 'Agent',
    description:
      'The agent that made it over MCP, by its personal access token (absent: a person did)',
  },
);

export function toAgentResource(
  label: AgentLabel | null,
): Static<typeof AgentResource> | undefined {
  return label === null ? undefined : { name: agentName(label) };
}
