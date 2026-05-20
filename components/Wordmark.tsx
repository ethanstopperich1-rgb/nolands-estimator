/**
 * Brand wordmark — text-only placeholder until the Noland's vector logo
 * SVG arrives (see BRAND.md asset checklist).
 *
 * Renders "NOLAND'S" in a bold condensed sans style with the metallic
 * silver gradient extracted from Noland's printed door-hangers.
 * When the real SVG logo lands, swap the <span> for an <img> or inline
 * SVG here and the rest of the app picks it up automatically.
 *
 * Sizes:
 *   sm — compact chrome (footer, sidebar). ~18px cap-height.
 *   md — page header nav. ~24px.
 *   lg — hero / landing. ~40px.
 */

"use client";

import type { CSSProperties } from "react";

export type WordmarkSize = "sm" | "md" | "lg";
export type WordmarkTone = "ink" | "cream";

const SIZE_PX: Record<WordmarkSize, number> = {
  sm: 18,
  md: 24,
  lg: 40,
};

// Metallic silver gradient extracted from Noland's door-hanger wordmark.
// Locked May 2026 — see BRAND.md.
const METALLIC_GRADIENT =
  "linear-gradient(180deg, #E8E9ED 0%, #6E7178 50%, #C8C9CD 100%)";

export function Wordmark({
  size = "md",
  // tone kept for API compatibility with upstream callers
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tone = "ink",
  className,
  style,
}: {
  size?: WordmarkSize;
  tone?: WordmarkTone;
  className?: string;
  style?: CSSProperties;
}) {
  const px = SIZE_PX[size];
  return (
    <span
      className={className}
      style={{
        fontFamily:
          '"Anton", "Bebas Neue", "Arial Narrow", "Impact", Arial, sans-serif',
        fontWeight: 900,
        fontSize: `${px}px`,
        lineHeight: 1,
        letterSpacing: "0.04em",
        // Metallic gradient via CSS background-clip trick
        background: METALLIC_GRADIENT,
        WebkitBackgroundClip: "text",
        WebkitTextFillColor: "transparent",
        backgroundClip: "text",
        display: "inline-block",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {"NOLAND'S"}
    </span>
  );
}

export default Wordmark;
