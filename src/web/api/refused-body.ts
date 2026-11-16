import type { FieldErrors } from '../auth/validation';
import { HttpError } from '../errors';
import { joinCopy } from '../i18n';

/**
 * A form reader's refusal as the API's 400: `errors` names each field as
 * a schema validation does (`body/<pointer>`, where the JSON body holds
 * it), with the message the form shows under it; `detail` joins them.
 * Used by every JSON body a page's form reader judges (the garment and
 * repair forms, garment-api-input.ts; the trip form, trips/api-routes.ts).
 */
export function refusedBody<Field extends string>(
  errors: FieldErrors<Field>,
  pointerOf: Record<Field, string>,
): HttpError {
  // eslint-disable-next-line closet/no-forged-copy -- the keys of a Record<Field, ...> are Fields, which name form fields, never copy
  const validation = (Object.keys(errors) as Field[]).flatMap((field) =>
    (errors[field] ?? []).map((message) => ({
      path: `body${pointerOf[field]}`,
      message,
    })),
  );
  return new HttpError(
    400,
    joinCopy(
      validation.map(({ message }) => message),
      ' ',
    ),
    {
      validation,
      logDetail: `refused fields: ${Object.keys(errors).join(', ')}`,
    },
  );
}
