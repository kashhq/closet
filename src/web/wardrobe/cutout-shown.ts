import type { CutoutStatus } from '../../cutout/state';
import type { GarmentDetail } from './queries';

/**
 * With CUTOUT_ENABLED=false nothing will ever finish a `pending` cutout or
 * retry a `failed` one, so every surface shows both as `none`: the page and
 * its poll fragment (the original with the mask editor's pencil, no spinner,
 * poll or "Try again"), the JSON API's garment reads and the changes feed
 * (no `pending` to poll for). Read-time only: the rows are untouched, so
 * turning removal back on resumes them.
 */
export function shownPhoto<P extends { cutoutStatus: CutoutStatus }>(
  photo: P,
  cutoutsEnabled: boolean,
): P {
  if (
    cutoutsEnabled ||
    (photo.cutoutStatus !== 'pending' && photo.cutoutStatus !== 'failed')
  ) {
    return photo;
  }
  return { ...photo, cutoutStatus: 'none' };
}

/**
 * A garment with its photo as shown (shownPhoto): what every view of a
 * garment's photo is handed, the garment page, its cutout poll and the
 * garment form's subject (GarmentPhotoView).
 */
export function withShownPhoto(
  garment: GarmentDetail,
  cutoutsEnabled: boolean,
): GarmentDetail {
  return {
    ...garment,
    photo: garment.photo && shownPhoto(garment.photo, cutoutsEnabled),
  };
}
