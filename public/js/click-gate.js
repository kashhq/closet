/**
 * Keeps a control that appears under the person's finger from taking a tap
 * meant for something else (#22d: the share confirmation's Save look, which
 * a page could otherwise time to the moment the shared photo shows). The
 * control opens only once it has been on a visible page for `delayMs`
 * without a break, and then refuses every click whose gesture began before
 * it opened: a click stamped earlier, or a pointer click whose pointerdown
 * was. A keyboard click (`detail` 0) has no pointerdown of its own.
 *
 * Used by share-confirm.js; unit-tested in src/web/inspiration/click-gate.spec.ts.
 */

/**
 * @param {{ timeStamp: number, detail?: number }} click
 * @param {number} openedAt when the control opened (performance.now() time)
 * @param {number} pointerDownAt the last pointerdown's timeStamp
 */
export function clickAllowed(click, openedAt, pointerDownAt) {
  if (!(click.timeStamp >= openedAt)) return false;
  return !click.detail || pointerDownAt >= openedAt;
}

/**
 * The slice of `document` visibleFor reads (click-gate.spec.ts fakes it).
 *
 * @typedef {object} VisibilitySource
 * @property {DocumentVisibilityState} visibilityState
 * @property {(type: 'visibilitychange', listener: () => void) => void} addEventListener
 * @property {(type: 'visibilitychange', listener: () => void) => void} removeEventListener
 */

/**
 * Resolves once `doc` has been visible for `delayMs` without a break: a
 * page sent to the background restarts the wait when it is back.
 *
 * @param {VisibilitySource} doc
 * @param {number} delayMs
 * @returns {Promise<void>}
 */
export function visibleFor(doc, delayMs) {
  return new Promise((resolve) => {
    let timer;
    const arm = () => {
      clearTimeout(timer);
      if (doc.visibilityState === 'visible') timer = setTimeout(done, delayMs);
    };
    const done = () => {
      doc.removeEventListener('visibilitychange', arm);
      resolve();
    };
    doc.addEventListener('visibilitychange', arm);
    arm();
  });
}

/**
 * Guards `button` (inside `form`, starting disabled): until `open()` is
 * called the form does not submit, and afterwards a click whose gesture
 * began earlier is swallowed. Answers `open`, which stamps the moment.
 *
 * @param {HTMLFormElement} form
 * @param {HTMLButtonElement} button
 * @returns {() => number}
 */
export function gateClicks(form, button) {
  let openedAt = Infinity;
  let pointerDownAt = -Infinity;
  // On the form, never the document: an inline module runs again on every
  // boosted visit. A pointerdown a disabled button swallows is not seen, so
  // its click reads the older one and is refused: the safe side.
  form.addEventListener(
    'pointerdown',
    (event) => {
      pointerDownAt = event.timeStamp;
    },
    { capture: true },
  );
  button.addEventListener(
    'click',
    (event) => {
      if (clickAllowed(event, openedAt, pointerDownAt)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      console.info('[click-gate] ignored a tap that began before Save opened');
    },
    { capture: true },
  );
  form.addEventListener(
    'submit',
    (event) => {
      if (performance.now() >= openedAt) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true },
  );
  return () => {
    openedAt = performance.now();
    return openedAt;
  };
}
