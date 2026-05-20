"use client";

import { usePathname } from "next/navigation";

/**
 * Gradient Background — radial spotlight from the top.
 * Drop inside a `relative` container; renders as an absolute backdrop.
 *
 * Self-hides on every customer-facing surface and the legal layout.
 * The `.voxaris` scope (Noland's dark theme) paints its own atmosphere
 * via the `.ambient` radial blend in globals.css, and the dashboard
 * uses `.lg-env` (visionOS Liquid Glass). Stacking another halo on
 * top of either creates dead pixels.
 *
 * The previous version used a purple/indigo radial — explicit
 * anti-pattern flagged by frontend-ui (the "AI aesthetic" purple
 * default). Fallback is now a storm-blue tint matching Noland's
 * "Severe Weather Specialists" positioning.
 */
export const GradientBackground = () => {
  const pathname = usePathname() ?? "/";
  if (
    pathname === "/" ||
    pathname.startsWith("/embed") ||
    pathname.startsWith("/quote") ||
    pathname.startsWith("/p/") ||
    pathname.startsWith("/privacy") ||
    pathname.startsWith("/terms") ||
    pathname.startsWith("/methodology")
  ) {
    return null;
  }

  return (
    <div
      aria-hidden
      className="absolute inset-0 h-full w-full"
      style={{
        background:
          "radial-gradient(125% 125% at 50% -50%, rgba(26, 31, 43, 0.55) 40%, transparent 100%)",
      }}
    />
  );
};

export default GradientBackground;
