import type { SVGProps, CSSProperties } from "react";

interface CuedLogoStaticProps
  extends Omit<SVGProps<SVGSVGElement>, "size" | "className" | "style"> {
  /** Size in pixels */
  size?: number;
  /** CSS class name */
  className?: string;
  /** Inline styles */
  style?: CSSProperties;
}

/**
 * Static logo for use in headers, favicons, etc.
 * Server-component compatible (no hooks).
 */
export function CuedLogoStatic({
  size = 32,
  className,
  style,
  ...props
}: CuedLogoStaticProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ cursor: "pointer", overflow: "visible", ...style }}
      {...props}
    >
      <defs>
        {/* Drop shadow (box shadow) */}
        <filter
          id="cued-logo-drop-shadow"
          x="-50%"
          y="-50%"
          width="200%"
          height="200%"
        >
          <feDropShadow
            dx="0"
            dy="1"
            stdDeviation="1.5"
            floodColor="black"
            floodOpacity="0.12"
          />
        </filter>
        {/* Inner shadow filter */}
        <filter
          id="cued-logo-inner-shadow"
          x="-50%"
          y="-50%"
          width="200%"
          height="200%"
        >
          <feComponentTransfer in="SourceAlpha">
            <feFuncA type="table" tableValues="1 0" />
          </feComponentTransfer>
          <feGaussianBlur stdDeviation="3" />
          <feOffset dx="0" dy="2" result="offsetblur" />
          <feFlood floodColor="black" floodOpacity="0.35" />
          <feComposite in2="offsetblur" operator="in" />
          <feComposite in2="SourceAlpha" operator="in" />
          <feMerge>
            <feMergeNode in="SourceGraphic" />
            <feMergeNode />
          </feMerge>
        </filter>
      </defs>
      {/* Outer circle with drop shadow and inner shadow */}
      <g filter="url(#cued-logo-drop-shadow)">
        <circle
          cx="16"
          cy="16"
          r="14"
          fill="var(--color-logo-ball)"
          filter="url(#cued-logo-inner-shadow)"
        />
      </g>
      {/* Center dot */}
      <circle cx="16" cy="16" r="3.5" fill="var(--color-orange)" />
    </svg>
  );
}

/**
 * Monochrome outline variant
 * Server-component compatible (no hooks).
 */
export function CuedLogoMono({
  size = 32,
  className,
  style,
  ...props
}: CuedLogoStaticProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ cursor: "pointer", ...style }}
      {...props}
    >
      {/* Outer circle - outline */}
      <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="1.5" />
      {/* Center dot - filled */}
      <circle cx="16" cy="16" r="4" fill="currentColor" />
    </svg>
  );
}
