import type { FastifyReply } from 'fastify';
import { hxTrigger } from '../htmx/trigger';

/**
 * The htmx event a write's answer raises with what it did ("Marked
 * washed"), which public/js/toast.js says in `#toast-host`, the page's one
 * polite status region (src/web/layout/app-status.tsx; #679). That plain
 * script spells the name itself, so the two change together. The failure
 * path is REQUEST_FAILED_EVENT (src/web/errors.tsx), into the same region.
 */
export const STATUS_EVENT = 'closet:status';

/**
 * A reversible write's Undo, a button in the toast (public/js/toast.js):
 * its tap posts `fields` to `action` (htmx, same origin, the answer's own
 * navigation) and the toast stays long enough to be reached.
 */
export interface StatusUndo {
  /** The button's words. */
  label: string;
  action: string;
  fields: Record<string, string>;
}

/** The event's detail. */
interface StatusMessage {
  message: string;
  undo?: StatusUndo;
}

/**
 * Says what an htmx write did, through the status region. For a write
 * swapped in place (a native post's landing page says it with SavedToast,
 * src/web/layout/parts.tsx): a live region inserted with the swap is not
 * reliably read, the persistent one is. Call before sending the answer.
 */
export function announce(
  reply: FastifyReply,
  message: string,
  undo?: StatusUndo,
): FastifyReply {
  const detail: StatusMessage = { message, undo };
  return reply.header('HX-Trigger', hxTrigger(STATUS_EVENT, detail));
}

/**
 * The htmx event a write's refusal raises when the person must confirm
 * first (public/js/confirm-sheet.js spells the name too): the confirm sheet
 * opens with `question`, and a yes posts `fields` (carrying `confirmed`) to
 * `action` again. For a request the page sent without asking because it
 * judged the write reversible and the server found it no longer is (#686).
 */
const CONFIRM_EVENT = 'closet:confirm';

export interface ConfirmRequest {
  question: string;
  /** The destructive button's words. */
  label: string;
  action: string;
  fields: Record<string, string>;
}

/** Answers 409 with nothing changed and the sheet to ask in. */
export function askFirst(
  reply: FastifyReply,
  ask: ConfirmRequest,
): FastifyReply {
  return reply
    .status(409)
    .header('HX-Trigger', hxTrigger(CONFIRM_EVENT, ask))
    .send();
}
