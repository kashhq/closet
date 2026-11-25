import { PostForm } from '../form';
import { t } from '../i18n';
import { CameraIcon, PhotoLibraryIcon } from '../layout/parts';
import { photoPick } from '../page-contract';

/**
 * A button that takes a photo of a look (the camera, `capture`) or picks
 * one (the library: a screenshot, a saved picture), posting it natively to
 * `action` (POST /inspiration for a new look, /inspiration/:id/photo for a
 * look's own): the answer is a 303 to the look's page. The input's change
 * prepares the photo on the phone (photo-input: 1600 px JPEG, HEIC left for
 * the server) and submits. Disabled offline, like every PostForm: an upload
 * needs the server.
 */
export function LookPhotoUpload(props: {
  action: string;
  source: 'camera' | 'library';
  /** The button's words; the source's own by default. */
  label?: string;
}) {
  const { source } = props;
  const label =
    props.label ??
    t(source === 'camera' ? 'inspiration.TAKE' : 'inspiration.CHOOSE');
  const Icon = source === 'camera' ? CameraIcon : PhotoLibraryIcon;
  return (
    <PostForm action={props.action} multipart class="flex-1">
      {/* `relative`: the sr-only input is absolutely positioned and would
          otherwise escape to the page (src/web/selfies/AGENTS.md). */}
      <label
        class="relative btn btn-outline w-full"
        data-inspiration-upload={source}
      >
        <Icon class="size-5" />
        {label}
        <input
          type="file"
          name="photo"
          accept="image/*"
          capture={source === 'camera' ? 'environment' : undefined}
          class="sr-only"
          {...photoPick()}
        />
      </label>
    </PostForm>
  );
}
