import { useId, type CSSProperties, type SVGProps } from "react"

interface CuedMarkProps
  extends Omit<SVGProps<SVGSVGElement>, "size" | "className" | "style"> {
  /** Height in pixels (width derived from 4:5 aspect ratio) */
  size?: number
  className?: string
  style?: CSSProperties
}

/**
 * Cued logomark — 4:5 portrait rounded rectangle with a circular cutout on
 * the right, bordered so the outline is always visible.
 */
export function CuedMark({
  size = 32,
  className,
  style,
  ...props
}: CuedMarkProps) {
  const id = useId()
  const clipId = `${id}-clip`
  const maskId = `${id}-mask`
  const width = size * 0.8

  return (
    <svg
      width={width}
      height={size}
      viewBox="0 0 25.6 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      {...props}
    >
      <defs>
        <clipPath id={clipId}>
          <path d="M5 3H20.6A2 2 0 0 1 22.6 5V27A2 2 0 0 1 20.6 29H5A2 2 0 0 1 3 27V5A2 2 0 0 1 5 3Z" />
        </clipPath>
        <mask id={maskId}>
          <path
            d="M5 0H20.6A5 5 0 0 1 25.6 5V27A5 5 0 0 1 20.6 32H5A5 5 0 0 1 0 27V5A5 5 0 0 1 5 0Z"
            fill="white"
          />
          <circle
            cx="22"
            cy="16"
            r="13"
            fill="black"
            clipPath={`url(#${clipId})`}
          />
        </mask>
      </defs>
      <path
        d="M5 0H20.6A5 5 0 0 1 25.6 5V27A5 5 0 0 1 20.6 32H5A5 5 0 0 1 0 27V5A5 5 0 0 1 5 0Z"
        fill="currentColor"
        mask={`url(#${maskId})`}
      />
    </svg>
  )
}
