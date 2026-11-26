// The importmap's libraries that ship no types, as pwa.ts uses them.
declare module 'pulltorefreshjs' {
  const PullToRefresh: {
    init(options: { mainElement: string; onRefresh(): void }): void;
    destroyAll(): void;
  };
  export default PullToRefresh;
}

// Imported only for its side effect: it defines <pwa-install>, whose type
// pwa.ts takes from the package itself.
declare module 'pwa-install';

// public/js/select-count.js, a plain script with no exports (its listeners
// sit on the document): page-mount.ts loads it for its side effect.
declare module 'select-count';
