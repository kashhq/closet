import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import jwt from 'jsonwebtoken';
import {
  type ConsentRequest,
  NAME_MAX,
  STATE_MAX,
  URL_MAX,
} from './authorize-request';

/**
 * The consent page's one signed hidden field (#1290; plan 4.2 step 6): the
 * request `GET /oauth/authorize` proved, so the POST trusts it, never loose
 * inputs, and never fetches the client's document again. An HS256 JWT on
 * ACCESS_TOKEN_SECRET with its own audience: a session token has no `aud`,
 * so it fails here, and this has no `userId`/`pwf`, so the session's
 * verify refuses it. It binds no user (the consent has no session): a
 * replay within its life still needs the password, and yields a code only
 * the PKCE verifier's holder can exchange.
 */
export const CONSENT_AUDIENCE = 'oauth-consent';
export const CONSENT_LIFETIME_SECONDS = 10 * 60;

/**
 * The longest field a request GET accepts can sign to, so the POST's body
 * schema never refuses one: every claim at its cap, each character as
 * four UTF-8 bytes and JSON-escaped twice over, base64url's 4/3, plus the
 * header, the claim names and the signature.
 */
export const CONSENT_FIELD_MAX = Math.ceil(
  ((URL_MAX * 2 + STATE_MAX + 128 + NAME_MAX * 4) * 2 + 512) * (4 / 3),
);

// Short names: the field rides in every consent page and its POST.
const ConsentClaims = Type.Object({
  cid: Type.String(),
  cn: Type.String(),
  ru: Type.String(),
  cc: Type.String(),
  st: Type.Optional(Type.String()),
  w: Type.Boolean(),
});
type ConsentClaims = Static<typeof ConsentClaims>;

export type ConsentField =
  | { ok: true; request: ConsentRequest }
  | { ok: false; reason: 'expired' | 'invalid' };

export interface ConsentTokens {
  sign(request: ConsentRequest): string;
  verify(field: string): ConsentField;
}

/** Built once by createApp (WebOptions.consentTokens); `issuer` is SITE_URL's origin. */
export function createConsentTokens(
  secret: string,
  issuer: string,
): ConsentTokens {
  return {
    sign(request) {
      const claims: ConsentClaims = {
        cid: request.clientId,
        cn: request.clientName,
        ru: request.redirectUri,
        cc: request.codeChallenge,
        ...(request.state === undefined ? {} : { st: request.state }),
        w: request.writeRequested,
      };
      return jwt.sign(claims, secret, {
        algorithm: 'HS256',
        audience: CONSENT_AUDIENCE,
        issuer,
        expiresIn: CONSENT_LIFETIME_SECONDS,
      });
    },
    verify(field) {
      let decoded: string | jwt.JwtPayload;
      try {
        decoded = jwt.verify(field, secret, {
          algorithms: ['HS256'],
          audience: CONSENT_AUDIENCE,
          issuer,
        });
      } catch (error) {
        return {
          ok: false,
          reason:
            error instanceof jwt.TokenExpiredError ? 'expired' : 'invalid',
        };
      }
      const request =
        typeof decoded === 'string' ? undefined : requestOf(decoded);
      return request === undefined
        ? { ok: false, reason: 'invalid' }
        : { ok: true, request };
    },
  };
}

/** The claims as a request, or undefined for a garbled (or forged) set. */
function requestOf(claims: jwt.JwtPayload): ConsentRequest | undefined {
  if (!Value.Check(ConsentClaims, claims)) return undefined;
  const { cid, cn, ru, cc, st, w } = claims;
  return {
    clientId: cid,
    clientName: cn,
    redirectUri: ru,
    codeChallenge: cc,
    ...(st === undefined ? {} : { state: st }),
    writeRequested: w,
  };
}
