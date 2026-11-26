/**
 * Every line icon the views draw goes through `Icon`: a 24-unit box, the
 * outline stroked in the text's colour with round ends and corners. The
 * drawings are Heroicons and Hugeicons outlines (credited in
 * THIRD-PARTY-NOTICES, scripts/third-party-notices.ts) or our own.
 *
 * An icon is decorative: the link or button around it carries the name
 * (an aria-label or visible text), so the svg is hidden from assistive tech.
 */
export function Icon(props: {
  /** One or more path outlines (an `M…` string each). */
  paths: string | readonly string[];
  class: string;
  /** Stroke width in the box's units; SVG's own default (1) when absent. */
  weight?: string;
  /** Extra attributes for a spec or a stylesheet to find the icon by. */
  data?: Readonly<Record<`data-${string}`, string>>;
}) {
  const outlines =
    typeof props.paths === 'string' ? [props.paths] : props.paths;
  return (
    <svg
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      class={props.class}
      fill="none"
      stroke="currentColor"
      stroke-width={props.weight}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...props.data}
    >
      {outlines.map((outline) => (
        <path d={outline} />
      ))}
    </svg>
  );
}
