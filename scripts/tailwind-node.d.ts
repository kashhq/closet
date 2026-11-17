// @tailwindcss/node ships types under `exports` conditions that this repo's `moduleResolution: node`
// cannot read; scripts/lg-check.ts uses only this much of it.
declare module '@tailwindcss/node' {
  export function compile(
    css: string,
    options: { base: string; onDependency: (path: string) => void },
  ): Promise<{ build(candidates: string[]): string }>;
}
