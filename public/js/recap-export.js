/**
 * The year in review's "Save image" (#26, docs/plans/2026-09-28-yearly-recap.md,
 * src/web/insights/recap-page.tsx): draws the year's card on a canvas from
 * the button's `data-card` (JSON, every string already in the
 * catalog's words) and hands the PNG to the share sheet where the browser
 * shares files (iOS Safari 15+, Android: "Save Image" puts it in Photos), or
 * downloads it.
 *
 * Why on the device: the page already has both fonts loaded, the theme's
 * tokens and the thumbnails (same-origin, so the canvas stays exportable),
 * where the server's sharp has no fonts in the slim image. It works offline
 * too, from the worker's cached thumbnails.
 *
 * The card is drawn as the page opens and the button enabled once the PNG
 * exists: WebKit's navigator.share needs the tap's user activation, which an
 * image load awaited inside the tap could outlive. A refused share (the
 * activation lapsed) falls back to the download; a cancelled one does
 * nothing. A card that could not be drawn says so in the note under the
 * button (aria-live, so it is read out) and leaves the button enabled: a tap
 * draws it again, and once it exists the next tap shares it.
 *
 * Evaluated once per document: page-mount.ts calls prepareRecapExport on
 * every visit a load, a boosted navigation or a history restore brings
 * (a restored snapshot has the button but not its listener). Preparing a
 * button twice is harmless.
 */

const WIDTH = 1080;
const HEIGHT = 1350;
const PAD = 72;
const INNER = WIDTH - 2 * PAD;
const MUTED_ALPHA = 0.65; // main.css's --color-muted: the ink at 65%

/** @type {WeakSet<HTMLButtonElement>} */
const prepared = new WeakSet();

/** @param {HTMLButtonElement | null} button */
export function prepareRecapExport(button) {
  if (!button || prepared.has(button)) return;
  if (!button.dataset.card) return;
  prepared.add(button);
  const data = JSON.parse(button.dataset.card);
  const note = document.getElementById('recap-export-note');
  const hint = note?.textContent ?? '';

  /** @type {File | null} */
  let file = null;
  let drawing = false;

  const draw = () => {
    drawing = true;
    button.disabled = true;
    const started = performance.now();
    drawCard(data)
      .then((blob) => {
        file = new File([blob], data.fileName, { type: 'image/png' });
        showNote(note, hint, false);
        console.info(
          `Recap: image drawn (${Math.round(blob.size / 1024)} KB) in ${Math.round(performance.now() - started)} ms`,
        );
      })
      .catch((err) => {
        showNote(note, data.failed, true);
        console.error('Recap: the image could not be drawn', err);
      })
      .finally(() => {
        drawing = false;
        button.disabled = false;
      });
  };

  button.addEventListener('click', () => {
    if (file) void deliver(file, data.title);
    else if (!drawing) draw();
  });
  draw();
}

/**
 * The note under the button: its hint, or why the card could not be drawn
 * (in the error colour). The note is aria-live, so the change is read out.
 * @param {HTMLElement | null} note
 * @param {string} text
 * @param {boolean} failed
 */
function showNote(note, text, failed) {
  if (!note) return;
  note.textContent = text;
  note.classList.toggle('text-error', failed);
  note.classList.toggle('text-muted', !failed);
}

/**
 * The share sheet where files can be shared, else a download. Called in
 * the tap, before any await, so the share keeps its user activation.
 * @param {File} file
 * @param {string} title
 */
async function deliver(file, title) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      console.info('Recap: image shared');
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.warn('Recap: share refused, downloading instead', err);
    }
  }
  download(file);
}

/** @param {File} file */
function download(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  // Long enough for the browser to have read it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  console.info('Recap: image downloaded');
}

/**
 * The light Atelier theme's tokens (the page's hidden [data-recap-theme]
 * probe), whatever the phone's scheme, and the fonts the page's own text
 * uses: the serif of its h1, the sans of its body.
 */
function theme() {
  const probe = document.querySelector('[data-recap-theme]');
  const tokens = getComputedStyle(probe ?? document.documentElement);
  const token = (name) => tokens.getPropertyValue(name).trim();
  const heading = document.querySelector('h1');
  return {
    page: token('--color-base-100'),
    plinth: token('--color-base-200'),
    line: token('--color-base-300'),
    ink: token('--color-base-content'),
    serif: getComputedStyle(heading ?? document.body).fontFamily,
    sans: getComputedStyle(document.body).fontFamily,
  };
}

/**
 * A worn colour's paint: the page's own strip segment for it (the swatch
 * classes in main.css); a pattern swatch has no plain colour, so the line
 * tone stands in.
 * @param {string} colour
 * @param {string} fallback
 */
function swatch(colour, fallback) {
  const segment = document.querySelector(
    `#recap-colours [data-colour="${CSS.escape(colour)}"]`,
  );
  const paint = segment ? getComputedStyle(segment).backgroundColor : '';
  return paint && paint !== 'rgba(0, 0, 0, 0)' && paint !== 'transparent'
    ? paint
    : fallback;
}

/** @param {string | null} src */
async function loadImage(src) {
  if (!src) return null;
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
    return image;
  } catch {
    // A missing thumb draws as the bare plinth, not a failed card.
    console.warn('Recap: a garment photo did not load');
    return null;
  }
}

/** @returns {Promise<Blob>} */
async function drawCard(data) {
  const colours = theme();
  // A font that will not load draws in its fallback (the stacks end in
  // Georgia and system-ui), not a failed card.
  await Promise.all([
    document.fonts.load(`600 88px ${colours.serif}`),
    document.fonts.load(`400 30px ${colours.sans}`),
    document.fonts.load(`600 30px ${colours.sans}`),
  ]).catch((err) => {
    console.warn('Recap: fonts did not load, drawing with fallbacks', err);
  });
  const garments = [
    ...data.mostWorn.garments,
    ...(data.bestValue ? [data.bestValue.garment] : []),
    ...(data.pair ? data.pair.garments : []),
  ];
  const images = new Map(
    await Promise.all(
      garments.map(async (g) => [g.image, await loadImage(g.image)]),
    ),
  );

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas');
  const draw = painter(ctx, colours, images);

  ctx.fillStyle = colours.page;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // The heading: the app, the title, the days.
  draw.text(data.appName, PAD, 102, { size: 30, weight: 600, muted: true });
  draw.text(data.title, PAD, 196, { size: 84, weight: 600, serif: true });
  draw.text(data.range, PAD, 248, { size: 32, muted: true });

  // The three numbers.
  const column = INNER / data.stats.length;
  data.stats.forEach((stat, i) => {
    const x = PAD + i * column;
    draw.text(stat.value, x, 366, { size: 96, weight: 600, serif: true });
    draw.text(stat.label, x, 410, { size: 30, muted: true, width: column });
  });
  ctx.fillStyle = colours.line;
  ctx.fillRect(PAD, 450, INNER, 2);

  // Most worn: up to three tiles on the plinth.
  draw.text(data.mostWorn.heading, PAD, 506, { size: 32, weight: 600 });
  const tile = 280;
  const gap = (INNER - 3 * tile) / 2;
  data.mostWorn.garments.forEach((garment, i) => {
    const x = PAD + i * (tile + gap);
    draw.garment(garment, x, 530, tile);
    draw.text(garment.name, x, 852, { size: 30, weight: 600, width: tile });
    draw.text(garment.detail, x, 890, { size: 28, muted: true, width: tile });
  });

  // Best value and the best pair, side by side.
  const half = (INNER - 48) / 2;
  const small = 160;
  if (data.bestValue) {
    const { heading, garment } = data.bestValue;
    draw.text(heading, PAD, 962, { size: 32, weight: 600 });
    draw.garment(garment, PAD, 986, small);
    const textX = PAD + small + 24;
    const textWidth = half - small - 24;
    draw.text(garment.name, textX, 1040, {
      size: 30,
      weight: 600,
      width: textWidth,
    });
    draw.text(garment.detail, textX, 1080, {
      size: 28,
      muted: true,
      width: textWidth,
    });
  }
  if (data.pair) {
    const x = PAD + half + 48;
    draw.text(data.pair.heading, x, 962, { size: 32, weight: 600 });
    data.pair.garments.forEach((garment, i) => {
      draw.garment(garment, x + i * (small + 16), 986, small);
    });
    draw.text(data.pair.detail, x, 1186, {
      size: 28,
      muted: true,
      width: half,
    });
  }

  // The colours worn: one strip, each colour as wide as its share.
  if (data.colours) {
    draw.text(data.colours.heading, PAD, 1234, { size: 32, weight: 600 });
    const segments = [
      ...data.colours.segments.map((s) => ({
        share: s.share,
        paint: swatch(s.colour, colours.line),
      })),
      { share: data.colours.uncoloured, paint: colours.line },
    ].filter((s) => s.share > 0);
    const total = segments.reduce((sum, s) => sum + s.share, 0);
    ctx.save();
    roundedRect(ctx, PAD, 1256, INNER, 36, 18);
    ctx.clip();
    let x = PAD;
    for (const segment of segments) {
      const width = (segment.share / total) * INNER;
      ctx.fillStyle = segment.paint;
      ctx.fillRect(x, 1256, width + 1, 36);
      x += width;
    }
    ctx.restore();
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Empty PNG'))),
      'image/png',
    );
  });
}

/** The card's text and garment tiles on `ctx`. */
function painter(ctx, colours, images) {
  return {
    /**
     * One line at baseline `y`, cut with an ellipsis to `width`.
     * @param {string} value
     * @param {number} x
     * @param {number} y
     * @param {{ size: number, weight?: number, serif?: boolean, muted?: boolean, width?: number }} style
     */
    text(value, x, y, style) {
      ctx.save();
      ctx.font = `${style.weight ?? 400} ${style.size}px ${style.serif ? colours.serif : colours.sans}`;
      ctx.fillStyle = colours.ink;
      if (style.muted) ctx.globalAlpha = MUTED_ALPHA;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(fit(ctx, value, style.width ?? INNER), x, y);
      ctx.restore();
    },
    /** A garment's thumb contained on the plinth, as the app draws one. */
    garment(garment, x, y, size) {
      ctx.save();
      roundedRect(ctx, x, y, size, size, 24);
      ctx.fillStyle = colours.plinth;
      ctx.fill();
      ctx.clip();
      const image = images.get(garment.image);
      if (image) {
        const inset = size * 0.08;
        const box = size - 2 * inset;
        const scale = Math.min(
          box / image.naturalWidth,
          box / image.naturalHeight,
        );
        const w = image.naturalWidth * scale;
        const h = image.naturalHeight * scale;
        ctx.drawImage(image, x + (size - w) / 2, y + (size - h) / 2, w, h);
      }
      ctx.restore();
    },
  };
}

/** `value`, or as much of it as fits in `width` with an ellipsis. */
function fit(ctx, value, width) {
  if (ctx.measureText(value).width <= width) return value;
  let end = value.length;
  while (end > 0 && ctx.measureText(`${value.slice(0, end)}…`).width > width) {
    end -= 1;
  }
  return `${value.slice(0, end).trimEnd()}…`;
}

/** A rounded rectangle's path (arcTo: roundRect is Safari 16+). */
function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}
