import { describe, expect, it } from 'vitest';
import { isStaticPath } from './static-prefixes';

describe('isStaticPath', () => {
  it.each([
    '/modules/htmx.min.js',
    '/assets/icon.png',
    '/js/gen/mask-editor.js',
    '/vendor/fonts/fonts.css',
    '/file/8d755fce.webp?v=3',
    '/file/nobg/8d755fce.webp',
    '/file/thumb/8d755fce.webp?v=1',
    '/file/watermark/abc',
    '/file/anything-under-the-prefix',
    '/bundle.css',
    '/sw.js?ts=1',
    '/manifest.json',
    '/favicon.ico',
    '/robots.txt',
    '/THIRD-PARTY-NOTICES.txt',
  ])('treats %s as static', (url) => {
    expect(isStaticPath(url)).toBe(true);
  });

  it.each([
    '/',
    '/wardrobe',
    '/wardrobe/12?ownerId=3',
    '/auth/login',
    '/auth/profile',
    '/modules',
    '/filebrowser',
    '/assetsx',
    '/vendorx',
    // The retired in-browser model's root: a 404 page now, not a static path.
    '/bg-removal-models/model.onnx',
  ])('treats %s as an app route', (url) => {
    expect(isStaticPath(url)).toBe(false);
  });
});
