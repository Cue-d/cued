import { motion, type Variants } from "motion/react";
import type { SVGProps, CSSProperties } from "react";

interface CuedLogoBaseProps {
  /** Size in pixels */
  size?: number;
  /** CSS class name */
  className?: string;
  /** Inline styles */
  style?: CSSProperties;
}

interface CuedLogoAnimatedProps extends CuedLogoBaseProps {
  /** Show rolling animation (for loading states) */
  animate?: boolean;
  /** Animation speed in seconds per rotation */
  animationDuration?: number;
}

type CuedLogoStaticProps = CuedLogoBaseProps &
  Omit<SVGProps<SVGSVGElement>, keyof CuedLogoBaseProps>;

/**
 * Cued Logo - A cue ball (circle with centered dot)
 */
export function CuedLogo({
  size = 32,
  animate = false,
  animationDuration = 1.2,
  className,
  style,
}: CuedLogoAnimatedProps) {
  const rollVariants: Variants = {
    idle: { rotate: 0 },
    rolling: {
      rotate: 360,
      transition: {
        duration: animationDuration,
        ease: "linear",
        repeat: Infinity,
      },
    },
  };

  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      variants={rollVariants}
      initial="idle"
      animate={animate ? "rolling" : "idle"}
    >
      {/* Outer circle */}
      <circle cx="16" cy="16" r="14" fill="currentColor" />
      {/* Center dot */}
      <circle cx="16" cy="16" r="4" fill="white" />
    </motion.svg>
  );
}

/**
 * Animated loading variant of the logo
 */
export function CuedLogoLoading({
  size = 24,
  ...props
}: Omit<CuedLogoAnimatedProps, "animate">) {
  return <CuedLogo size={size} animate {...props} />;
}

/**
 * Static logo for use in headers, favicons, etc.
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
      style={style}
      {...props}
    >
      {/* Outer circle */}
      <circle cx="16" cy="16" r="14" fill="currentColor" />
      {/* Center dot */}
      <circle cx="16" cy="16" r="4" fill="white" />
    </svg>
  );
}

/**
 * Monochrome outline variant
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
      style={style}
      {...props}
    >
      {/* Outer circle - outline */}
      <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="1.5" />
      {/* Center dot - filled */}
      <circle cx="16" cy="16" r="4" fill="currentColor" />
    </svg>
  );
}
