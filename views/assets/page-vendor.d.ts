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
