import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type * as z from 'zod';
import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import type { TokenScope } from '../auth/personal-tokens';
import type { McpEnding, Metrics } from '../../metrics/metrics';
import { describeError } from '../errors';
import type { Photos } from '../files/photos';
import type { PushSender } from '../push/sender';
import type { OutboundFetcher } from '../security/outbound-fetch';
import {
  type Actor,
  authorizeWardrobe,
  type WardrobeNeed,
} from '../sharing/access';
import type { WeatherService } from '../weather/service';
import type { WriteOrigin } from '../write-origin';

/**
 * The MCP tools' shared shape (#33). A tool is data (name, description,
 * input schema, whether it writes) plus `run`, which calls the same query
 * and write functions the pages use and returns plain data; registerTools
 * turns each into an SDK tool that answers JSON text and logs the call.
 * A tool that answers a picture returns an ImageAnswer instead
 * (get_garment_photo). Refusals are the domain functions' NotFound and
 * Forbidden (src/web/refusals.ts), as in a route, under the same policy
 * (src/web/sharing/access.ts): a wardrobe,
 * garment, capsule, outfit or entry the caller cannot see is "not found"
 * like an unknown id; one they can see but may not change is "not allowed".
 */

/** What every tool gets: the app's services and who is calling. */
export interface ToolContext {
  db: Db;
  photos: Photos;
  cutouts: { wake(): void; readonly enabled: boolean };
  fetcher: OutboundFetcher;
  /** The Web Push sender; undefined without PWA_ENABLED (finish_round then notifies nobody). */
  push: PushSender | undefined;
  /** The weather; undefined with WEATHER_ENABLED=false (no weather tool is listed then). */
  weather: WeatherService | undefined;
  /** The Web logger: the writers the tools call log through it, as for a page. */
  webLogger: Logger;
  /** APP_TIMEZONE: "today" is the household's. */
  timeZone: string;
  /** The token's user: every tool acts as them, within `scope`. */
  userId: number;
  /**
   * The token's scope (#701). Read by two places only, never by a tool:
   * scopedTools (no write tool for a read-only token) and actorOf (an
   * own-wardrobe-only actor, refused by the access resolver).
   */
  scope: TokenScope;
  /**
   * The token's row id: the call's log line, the provenance of what the
   * agent suggests (#337: a need's, a pick's, an outfit's token) and its
   * feedback cursor. Never the token itself.
   */
  tokenId: number;
  /**
   * add_garment_from_link's budget (MCP_LINK_IMPORT_LIMIT, per user): false
   * when this call would pass it.
   */
  allowLinkImport(): Promise<boolean>;
}

export interface ClosetTool<Input extends z.ZodObject> {
  name: string;
  title: string;
  /** Says what the tool does and, for a write, that it writes. */
  description: string;
  input: Input;
  /**
   * Changes stored data. Nothing deletes: there is no destructive tool.
   * Also the read-only scope's boundary (scopedTools): a tool marked false
   * must write nothing a person would see (mcp-statements.spec runs every
   * one through a read-only token against a row diff), and MCP_WRITES
   * (src/web/api/operations.ts) lists exactly the true ones.
   */
  writes: boolean;
  /** Calling it again with the same arguments changes nothing more. */
  idempotent?: boolean;
  /** Reaches beyond the app (add_garment_from_link fetches a shop's page). */
  openWorld?: boolean;
  run(args: z.output<Input>, ctx: ToolContext): Promise<unknown>;
}

/** Typed identity: each tools module lists its tools through it. */
export function defineTool<Input extends z.ZodObject>(
  tool: ClosetTool<Input>,
): ClosetTool<Input> {
  return tool;
}

/**
 * The token's user as a domain function's Actor: no session, so no share
 * read ahead; an own-wardrobe-only token's actor says so, and the access
 * resolver refuses it every other wardrobe (src/web/sharing/access.ts).
 */
export function actorOf(ctx: Pick<ToolContext, 'userId' | 'scope'>): Actor {
  return ctx.scope.ownWardrobeOnly
    ? { userId: ctx.userId, ownWardrobeOnly: true }
    : { userId: ctx.userId };
}

/**
 * The tools a token of `scope` is given (#701): every one, or for a
 * read-only token those marked `writes: false` and nothing else (so a
 * tool whose flag is anything but false is withheld). The one check of
 * the read-only scope: a withheld tool is never registered, so
 * `tools/list` omits it and `tools/call` gets the SDK's unknown-tool
 * error. The route logs a call to one (withheld).
 */
export function scopedTools(
  tools: readonly ClosetTool<z.ZodObject>[],
  scope: TokenScope,
): {
  granted: readonly ClosetTool<z.ZodObject>[];
  withheld: ReadonlySet<string>;
} {
  if (!scope.readOnly) return { granted: tools, withheld: new Set() };
  return {
    granted: tools.filter((tool) => tool.writes === false),
    withheld: new Set(
      tools.filter((tool) => tool.writes !== false).map((tool) => tool.name),
    ),
  };
}

/**
 * The calling token as a writer's WriteOrigin (#682): every stamping writer
 * a tool reaches takes it, so what the agent made carries its token
 * (MCP_WRITES' `attribution`, src/web/api/operations.ts).
 */
export function originOf(ctx: Pick<ToolContext, 'tokenId'>): WriteOrigin {
  return { agentTokenId: ctx.tokenId };
}

/**
 * The wardrobe a tool addresses (`ownerId` absent: the caller's own),
 * resolved and refused exactly as a page's `?ownerId=` is.
 */
export async function wardrobeFor(
  ctx: ToolContext,
  ownerId: number | undefined,
  need: WardrobeNeed,
) {
  const { access } = await authorizeWardrobe(
    ctx.db,
    actorOf(ctx),
    ownerId,
    need,
    'wardrobe',
  );
  return access;
}

/**
 * A tool's answer that is a picture: an MCP image content block (base64,
 * its MIME type), after a text block with `about` (what the picture is of).
 * The bytes go to the client only, never to a log line.
 */
export class ImageAnswer {
  constructor(
    readonly about: unknown,
    readonly data: Buffer,
    readonly mimeType: string,
  ) {}
}

/**
 * Why a call ended, for the log line: a 4xx is 'refused', a chosen 5xx (the
 * owner lock's 503) 'failed', either with the error's log detail.
 */
type Outcome = 'ok' | 'error' | `${'refused' | 'failed'} ${number}${string}`;

// The metric's outcome drops the refusal's status (a closed label set); an
// unexpected error goes with it to the error tracker.
function metricEnding(outcome: Outcome, error: unknown): McpEnding {
  if (outcome === 'error') return { outcome, error };
  return { outcome: outcome === 'ok' ? 'ok' : 'refused' };
}

function textResult(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError && { isError: true }),
  };
}

function toolResult(value: unknown): CallToolResult {
  if (!(value instanceof ImageAnswer)) return textResult(value);
  return {
    content: [
      { type: 'text', text: JSON.stringify(value.about) },
      {
        type: 'image',
        data: value.data.toString('base64'),
        mimeType: value.mimeType,
      },
    ],
  };
}

/**
 * Registers `tools` on this request's server. One log line per call
 * (context Mcp): the tool, the user, the token's row id, the outcome and
 * the time; never the arguments (a link can carry a token of its own),
 * never the caller's token and never an answer (an image's bytes
 * included). A refusal (a 4xx HttpError, as a route would answer) is a tool error with its message, which the call's line carries too (one line per call, at info; a chosen 5xx, the line at warn); anything else is logged with
 * its stack, sent to the error tracker (through the metrics) and answered
 * without detail.
 */
export function registerTools(
  server: McpServer,
  tools: readonly ClosetTool<z.ZodObject>[],
  ctx: ToolContext,
  log: { logger: Logger; metrics: Metrics },
): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: !tool.writes,
          destructiveHint: false,
          idempotentHint: tool.idempotent ?? !tool.writes,
          openWorldHint: tool.openWorld ?? false,
        },
      },
      async (args: Record<string, unknown>) => {
        const started = performance.now();
        let outcome: Outcome = 'ok';
        let failure: unknown;
        let refusal: string | undefined;
        let level: 'info' | 'warn' = 'info';
        try {
          return toolResult(await tool.run(args, ctx));
        } catch (error) {
          const { status, message, logDetail, unexpected } =
            describeError(error);
          if (unexpected) {
            outcome = 'error';
            failure = error;
            log.logger.error(
              { err: error },
              `MCP ${tool.name} failed for user ${ctx.userId}`,
            );
          } else {
            if (status >= 500) level = 'warn';
            outcome = `${status >= 500 ? 'failed' : 'refused'} ${status}${logDetail ? ` (${logDetail})` : ''}`;
            refusal = message;
          }
          return textResult({ error: message }, true);
        } finally {
          const elapsedMs = performance.now() - started;
          log.logger[level](
            `MCP ${tool.name} by user ${ctx.userId} (token ${ctx.tokenId}): ${outcome}${refusal ? `: ${refusal}` : ''} ${elapsedMs.toFixed(1)}ms`,
          );
          log.metrics.observeMcpCall(
            tool.name,
            metricEnding(outcome, failure),
            elapsedMs / 1000,
          );
        }
      },
    );
  }
}
