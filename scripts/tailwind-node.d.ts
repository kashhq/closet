// @tailwindcss/node ships types under `exports` conditions that this repo's `moduleResolution: node`
// cannot read (still so with it a direct devDependency: TS2307 under `moduleResolution: node`);
// scripts/lg-check.ts uses only this much of it. Drop this file when the resolution setting moves.
declare module '@tailwindcss/node' {
  export function compile(
    css: string,
    options: { base: string; onDependency: (path: string) => void },
  ): Promise<{ build(candidates: string[]): string }>;
}
