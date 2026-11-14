import { Type, type Static } from '@sinclair/typebox';
import { t } from '../i18n';
import { PUSH_ENDPOINT_FIELD } from '../push/settings';
import { passwordProblems } from './passwords';

/**
 * Two layers, on purpose. The TypeBox schemas below are the route's Fastify
 * schema: a body that is not the form's shape (a missing field, a non-string)
 * never reaches the handler and gets a 400 error page, and the handler's
 * types are inferred from them. What a person can get wrong in a well-formed
 * form (an invalid address, a weak or mismatched password) is checked by the
 * validate* functions, whose messages the page shows under each field.
 */

// Generous caps: the columns are varchar(255), and bcrypt reads only the
// first 72 bytes of a password.
export const Email = Type.String({ maxLength: 255 });
export const Password = Type.String({ maxLength: 1024 });

// The page to land on after signing in, a hidden field (return-to.ts). Unknown:
// a repeated or odd value is the `/` fallback (signInReturnTo), never a 400.
const ReturnTo = Type.Optional(Type.Unknown());

const Credentials = Type.Object({ email: Email, password: Password });

export const LoginBody = Type.Object({
  ...Credentials.properties,
  returnTo: ReturnTo,
});
export type LoginBody = Static<typeof LoginBody>;

export const RegisterBody = Type.Object({
  email: Email,
  password: Password,
  confirmPassword: Password,
  returnTo: ReturnTo,
});
export type RegisterBody = Static<typeof RegisterBody>;

/** What the inline check of the email form looks at. */
export const UpdateEmailFields = Type.Object({
  email: Email,
  confirmEmail: Email,
});
export type UpdateEmailFields = Static<typeof UpdateEmailFields>;

// The email is the login name: changing it needs the password, like
// changing the password does, so an unattended session cannot take the
// account over. The route checks it; validateEmailChange does not.
export const UpdateEmailBody = Type.Object({
  ...UpdateEmailFields.properties,
  currentPassword: Password,
});
export type UpdateEmailBody = Static<typeof UpdateEmailBody>;

export const ChangePasswordBody = Type.Object({
  currentPassword: Password,
  newPassword: Password,
  confirmPassword: Password,
  // This device's push subscription (<push-endpoint>, public/js/push.js):
  // the one the new password leaves in place. Empty when the browser has
  // none; absent from pages cached before it. Only ever compared with this
  // user's own rows, so anything else in it keeps nothing.
  [PUSH_ENDPOINT_FIELD]: Type.Optional(Type.String({ maxLength: 2048 })),
});
export type ChangePasswordBody = Static<typeof ChangePasswordBody>;

// Sign out everywhere (#700) asks for the password: the acting session
// survives it, so a stolen cookie must not be able to sign the owner out of
// every other device and keep itself. The push endpoint as above.
export const SignOutEverywhereBody = Type.Object({
  currentPassword: Password,
  [PUSH_ENDPOINT_FIELD]: Type.Optional(Type.String({ maxLength: 2048 })),
});
export type SignOutEverywhereBody = Static<typeof SignOutEverywhereBody>;

/** Account deletion asks for the account's own credentials again. */
export const DeleteAccountBody = Credentials;
export type DeleteAccountBody = Static<typeof Credentials>;

/** Messages per form field; a field without problems has no entry. */
export type FieldErrors<Field extends string> = Partial<
  Record<Field, string[]>
>;

export function hasErrors(errors: FieldErrors<string>): boolean {
  return Object.values(errors).some((messages) => messages?.length);
}

// Deliberately loose (one @, a dot in the domain, no spaces): the address
// is a login name here, never mailed.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailErrors(email: string): string[] {
  return EMAIL_SHAPE.test(email.trim()) ? [] : [t('validation.IS_EMAIL')];
}

function newPasswordErrors(password: string): string[] {
  return passwordProblems(password).map((key) => t(key));
}

function only<Field extends string>(
  entries: [Field, string[]][],
): FieldErrors<Field> {
  const errors: FieldErrors<Field> = {};
  for (const [field, messages] of entries) {
    if (messages.length) errors[field] = messages;
  }
  return errors;
}

export function validateRegistration(
  body: RegisterBody,
): FieldErrors<keyof RegisterBody> {
  return only<keyof RegisterBody>([
    ['email', emailErrors(body.email)],
    ['password', newPasswordErrors(body.password)],
    [
      'confirmPassword',
      body.confirmPassword === body.password
        ? []
        : [t('validation.PASSWORDS_MUST_MATCH')],
    ],
  ]);
}

export function validateEmailChange(
  body: UpdateEmailFields,
): FieldErrors<keyof UpdateEmailFields> {
  return only<keyof UpdateEmailFields>([
    ['email', emailErrors(body.email)],
    [
      'confirmEmail',
      body.confirmEmail.trim().toLowerCase() === body.email.trim().toLowerCase()
        ? []
        : [t('validation.EMAIL_MUST_MATCH')],
    ],
  ]);
}

export function validatePasswordChange(
  body: ChangePasswordBody,
): FieldErrors<keyof ChangePasswordBody> {
  return only<keyof ChangePasswordBody>([
    ['newPassword', newPasswordErrors(body.newPassword)],
    [
      'confirmPassword',
      body.confirmPassword === body.newPassword
        ? []
        : [t('validation.PASSWORDS_MUST_MATCH')],
    ],
  ]);
}
