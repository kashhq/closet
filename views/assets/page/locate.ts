/**
 * "Use my location" on the profile's weather section
 * (src/web/weather/settings.tsx; #14). Shows the button only where the
 * browser can locate (Geolocation needs a secure context: the https name,
 * the installed app), asks for the position on the tap (a permission prompt
 * needs the gesture), rounds it to 2 decimals (about 1 km) here, so the
 * precise position never leaves the phone, and posts it through the
 * hidden htmx form of the section's location part, which answers that part
 * again. The server rounds again; nothing else is sent.
 *
 * Called by page-mount.ts each time the location part is rendered or
 * swapped in, with its element: every listener is on an element inside it,
 * never on the document.
 */
import {
  LOCATE,
  LOCATE_DENIED,
  LOCATE_FAILED,
  LOCATE_FORM_ID,
  LOCATE_NOT_SAVED,
  LOCATE_STATUS,
} from '../../../src/web/page-contract';

const DECIMALS = 2;
// A position the phone found in the last ten minutes is good enough, and
// coarse is all the weather needs (and quicker, and kinder to the battery).
const OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  maximumAge: 600_000,
  timeout: 15_000,
};
const PERMISSION_DENIED = 1;

/** The hidden form's fields the position goes into (HereControls). */
interface HereForm extends HTMLFormElement {
  readonly elements: HTMLFormControlsCollection & {
    latitude: HTMLInputElement;
    longitude: HTMLInputElement;
  };
}

export function initLocate(part: HTMLElement | null) {
  const button = part?.querySelector<HTMLButtonElement>(`[${LOCATE}]`);
  const form = part?.querySelector<HereForm>(`#${LOCATE_FORM_ID}`);
  const status = part?.querySelector<HTMLElement>(`[${LOCATE_STATUS}]`);
  if (!button || !form || !status) return;
  if (!window.isSecureContext || !('geolocation' in navigator)) return;
  button.hidden = false;
  // The words are the server's, on the status line (locateStatus).
  const failed = (message: string | null) => {
    button.disabled = false;
    status.textContent = message;
    status.hidden = false;
  };
  // A post that fails (offline, a server error, the rate limit) swaps
  // nothing, so the button would stay disabled with no way to try again:
  // htmx reports it here, on the form that sent it. A success swaps this
  // whole part, button included.
  form.addEventListener('htmx:afterRequest', (event) => {
    if (!(event as CustomEvent<{ successful: boolean }>).detail.successful) {
      failed(status.getAttribute(LOCATE_NOT_SAVED));
    }
  });
  button.addEventListener('click', () => {
    button.disabled = true;
    status.hidden = true;
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        form.elements.latitude.value = coords.latitude.toFixed(DECIMALS);
        form.elements.longitude.value = coords.longitude.toFixed(DECIMALS);
        form.requestSubmit();
      },
      (error) =>
        failed(
          status.getAttribute(
            error.code === PERMISSION_DENIED ? LOCATE_DENIED : LOCATE_FAILED,
          ),
        ),
      OPTIONS,
    );
  });
}
