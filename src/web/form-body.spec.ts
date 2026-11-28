import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { lfLineBreaks, normalizeUrlencodedBody } from './form-body';

const run = (contentType: string, body: unknown) => {
  const request = {
    headers: { 'content-type': contentType },
    body,
  } as unknown as FastifyRequest;
  normalizeUrlencodedBody(request, {} as FastifyReply, () => undefined);
  return request.body;
};

describe('form line breaks', () => {
  it('turns CRLF and a lone CR into LF', () => {
    expect(lfLineBreaks('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('normalizes strings and string lists of an urlencoded body, whatever the header case', () => {
    expect(
      run('Application/X-WWW-Form-Urlencoded; charset=UTF-8', {
        note: 'a\r\nb',
        tags: ['c\r\nd', 'e'],
        n: 3,
      }),
    ).toEqual({ note: 'a\nb', tags: ['c\nd', 'e'], n: 3 });
  });

  it('leaves a JSON body as sent', () => {
    expect(run('application/json', { note: 'a\r\nb' })).toEqual({
      note: 'a\r\nb',
    });
  });
});
