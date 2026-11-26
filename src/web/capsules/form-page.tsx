import type { FieldErrors } from '../auth/validation';
import { FormField, inputAttributes } from '../form-field';
import { t } from '../i18n';
import { FormPage } from '../layout/form-page';
import type { ViewContext } from '../view-context';
import {
  CAPSULE_NAME_MAX,
  CAPSULE_NOTES_MAX,
  type CapsuleField,
} from './validation';

export interface CapsuleFormModel {
  /** Absent for a new capsule. */
  capsuleId?: number;
  values: { name: string; notes: string };
  errors?: FieldErrors<CapsuleField>;
}

/**
 * GET /capsules/new and /capsules/:id/edit (the owner's only), and their
 * re-render with the message when a post is refused (400), in the shared
 * add/edit frame (`FormPage`: a native post, disabled offline, #411). The
 * edit form also deletes the capsule (its garments stay in the closet).
 */
export function CapsuleFormPage(props: {
  ctx: ViewContext;
  model: CapsuleFormModel;
}) {
  const { ctx, model } = props;
  const { capsuleId, values, errors = {} } = model;
  const editing = capsuleId !== undefined;
  const url = editing ? `/capsules/${capsuleId}` : '/capsules';
  return (
    <FormPage
      ctx={ctx}
      title={t(editing ? 'EDIT_CAPSULE' : 'NEW_CAPSULE')}
      back={url}
      action={url}
      submitLabel={t('SAVE')}
      remove={
        editing
          ? {
              url,
              confirm: t('CONFIRM_DELETE_CAPSULE'),
              label: t('DELETE_CAPSULE'),
            }
          : undefined
      }
    >
      <FormField
        id="capsule-name"
        label={t('NAME')}
        required
        messages={errors.name}
      >
        <input
          {...inputAttributes('capsule-name', 'w-full', errors.name)}
          type="text"
          name="name"
          value={values.name}
          maxlength={CAPSULE_NAME_MAX}
          required
          placeholder={t('CAPSULE_NAME_PLACEHOLDER')}
        />
      </FormField>
      <FormField id="capsule-notes" label={t('NOTES')}>
        <textarea
          id="capsule-notes"
          class="textarea textarea-bordered w-full"
          name="notes"
          rows={3}
          maxlength={CAPSULE_NOTES_MAX}
          placeholder={t('CAPSULE_NOTES_PLACEHOLDER')}
        >
          {values.notes}
        </textarea>
      </FormField>
    </FormPage>
  );
}
