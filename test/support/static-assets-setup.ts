import {
  buildPageModules,
  precompress,
  syncClientModules,
} from '../../scripts/static-assets';
import { writeNotices } from '../../scripts/third-party-notices';

/**
 * Vitest globalSetup for the integration project: public/ as the build
 * leaves it for what the app serves from disk (the client libraries in
 * public/modules/, the page modules in public/js/gen/, every precompressed
 * variant), so the specs meet production's static delivery without a
 * build. Each step skips what is already current, so a repeat run costs a
 * directory walk and one esbuild pass.
 */
export default function setup(): void {
  syncClientModules();
  buildPageModules();
  writeNotices();
  precompress();
}
