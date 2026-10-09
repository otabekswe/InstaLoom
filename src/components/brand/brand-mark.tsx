import type { SVGProps } from "react";

/** Woven conversation mark. Standalone SVGs are available in public/brand. */
export function BrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="32" height="32" fill="none"
      stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false" {...props}>
      <g transform="translate(0 -2)">
        <path d="M40 14C39.1 10.5 35.9 8 32 8H16a8 8 0 0 0-8 8v28l10-4h14c3.9 0 7.1-2.5 8-6" />
        <path d="M24 30c.9-3.5 4.1-6 8-6h16a8 8 0 0 1 8 8v28l-10-4H32c-3.9 0-7.1-2.5-8-6" />
      </g>
    </svg>
  );
}
