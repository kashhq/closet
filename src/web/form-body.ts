import type {
  Multipart,
  MultipartFile,
  MultipartValue,
} from '@fastify/multipart';
import type {
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';

/**
 * Line breaks in a form's text, as the person typed them. A browser submits
 * every textarea line break as CRLF (HTML's form submission rule) while the
 * control's `maxlength` counted it as one character, so a note at its limit
 * would be refused by a schema counting the raw value. This is the one place
 * that fixes it, for every page form: a feature never normalizes line breaks
 * itself, and its schema's `maxLength` is the textarea's.
 *
 * Urlencoded bodies are normalized by `normalizeUrlencodedBody` (a root
 * preValidation hook, app.ts); multipart text fields by `formParts`, which
 * every `request.parts()` reader goes through. JSON bodies (/api/v1, /mcp)
 * are left alone: a native client sends the text it means, and its length is
 * what the schema counts.
 */
export function lfLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

const URLENCODED = 'application/x-www-form-urlencoded';

/** preValidation: the parsed urlencoded body's strings, CRLF to LF. */
export function normalizeUrlencodedBody(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
  const body = request.body;
  if (
    !request.headers['content-type']?.toLowerCase().startsWith(URLENCODED) ||
    typeof body !== 'object' ||
    body === null
  ) {
    done();
    return;
  }
  const fields = body as Record<string, unknown>;
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === 'string') fields[name] = lfLineBreaks(value);
    else if (Array.isArray(value)) {
      fields[name] = value.map((item: unknown) =>
        typeof item === 'string' ? lfLineBreaks(item) : item,
      );
    }
  }
  done();
}

/**
 * `request.parts(options)` with each text field's value normalized; file
 * parts pass untouched, their bytes are never read here. Every multipart
 * reader goes through this file, never `request.parts`, `file`, `files` or
 * `saveRequestFiles` itself (guards.conf `@multipart-readers`).
 */
export async function* formParts(
  request: FastifyRequest,
  options?: Parameters<FastifyRequest['parts']>[0],
): AsyncIterable<Multipart> {
  for await (const part of request.parts(options)) {
    yield part.type === 'field' ? normalizedField(part) : part;
  }
}

function normalizedField(field: MultipartValue): MultipartValue {
  return typeof field.value === 'string'
    ? { ...field, value: lfLineBreaks(field.value) }
    : field;
}

/** `request.files(options)`: the file parts only, text fields skipped unread. */
export function formFiles(
  request: FastifyRequest,
  options?: Parameters<FastifyRequest['files']>[0],
): AsyncIterableIterator<MultipartFile> {
  return request.files(options);
}

/** `request.file()`: the body's first file part, its text fields skipped unread. */
export function formFile(
  request: FastifyRequest,
): Promise<MultipartFile | undefined> {
  return request.file();
}
