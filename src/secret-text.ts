import { SESSION_COOKIE, TOKEN_PREFIX } from './credential-names';

// Credential shapes inside free text. Used by src/metrics/error-tracker.ts (every string of an
// event) and src/logger.ts (errorFields' message and stack): one list, so a shape added here
// leaves neither Bugsink nor Loki. Closet leaked session JWTs to Loki once
// (docs/audits/2026-09-25-closet-stack-and-backups.md): the session token is a JWT, so every
// JWT goes, whatever carried it.

export const FILTERED = '[Filtered]';

const SECRET_PATTERNS: [RegExp, string][] = [
  [/eyJ[\w-]*\.[\w-]+\.[\w-]*/g, FILTERED],
  [
    new RegExp(`\\b${SESSION_COOKIE}=[^;\\s"']*`, 'g'),
    `${SESSION_COOKIE}=${FILTERED}`,
  ],
  // Every credential closet mints starts `closet_`: an agent or device token, and OAuth's
  // refresh token (`closet_rt_`) and code (`closet_code_`, #1291); `_` is a word character, so
  // one shape takes all of them (secret-text.spec.ts holds each).
  [new RegExp(`\\b${TOKEN_PREFIX}[\\w-]+`, 'g'), `${TOKEN_PREFIX}${FILTERED}`],
  [/\bBearer\s+[^\s"']+/gi, `Bearer ${FILTERED}`],
  // Fastmail API tokens (the order mail's, #25): `fmu1-` and hex groups.
  [/\bfm[a-z]\d-[\w-]+/gi, FILTERED],
  // Drizzle's failed-query message ends with the query's parameters: what a user sent (an
  // email, a hash, a note), never needed to group or debug an error. The cut runs to the end of
  // the text, so pass a message, not a stack (errorFields splices a stack's message itself).
  [/\nparams: [\s\S]*$/, `\nparams: ${FILTERED}`],
];

export function scrubSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (scrubbed, [pattern, replacement]) =>
      scrubbed.replace(pattern, replacement),
    text,
  );
}
