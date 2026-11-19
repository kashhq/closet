import path from 'path';
import { PUBLIC_DIR } from '../src/static-assets';
import {
  buildPageModules,
  watchPageModules,
  pageModuleEntries,
  precompress,
  syncClientModules,
} from './static-assets';
import { NOTICES_FILE, writeNotices } from './third-party-notices';

// `npm run generate:modules`, `generate:pages`, `generate:notices` and `generate:precompress`
// (all in `npm run build`); the steps themselves are in scripts/static-assets.ts.
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

const step = process.argv[2];
if (step === 'modules') {
  const { copied, removed } = syncClientModules();
  console.log(
    `public/modules: ${copied.length} copied${copied.length ? ` (${copied.join(', ')})` : ''}, ${removed.length} removed`,
  );
} else if (step === 'pages') {
  const { written, removed } = buildPageModules();
  console.log(
    `public/js: ${Object.keys(pageModuleEntries()).length} page modules, ${written.length} written${written.length ? ` (${written.join(', ')})` : ''}, ${removed.length} removed`,
  );
} else if (step === 'pages:watch') {
  void watchPageModules();
} else if (step === 'notices') {
  const { bytes, written } = writeNotices();
  console.log(
    `${path.relative(process.cwd(), NOTICES_FILE)}: ${kb(bytes)}${written ? '' : ' (current)'}`,
  );
} else if (step === 'precompress') {
  const started = Date.now();
  const r = precompress();
  console.log(
    `Precompressed ${path.relative(process.cwd(), PUBLIC_DIR)}/: ${r.written} written` +
      (r.written ? ` (brotli ${kb(r.bytes)} -> ${kb(r.brotliBytes)})` : '') +
      `, ${r.current} current, ${r.removed} removed, ${Date.now() - started} ms`,
  );
} else {
  console.error(
    'Usage: generate-static-assets.ts modules|pages|pages:watch|notices|precompress',
  );
  process.exit(1);
}
