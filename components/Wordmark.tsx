/**
 * Brand wordmark — Noland's Roofing high-res logo.
 *
 * Upgraded May 2026 from the prior 400×322 web-grab (sourced from
 * nolandsroofing.com/wp-content/uploads/2024/06/Transparent-horizontal-sm.png)
 * to the print-grade 2450×1751 variant Destiny shipped on the
 * onboarding form. New logo includes the "+SOLAR" callout matching
 * the May 2026 Noland's Roofing Solar sub-brand.
 *
 * Two variants live in /public/brand/nolands/ (sourced from the
 * Nolands Roofing Logos.zip Destiny sent):
 *   - logo-light.png — color logo for LIGHT backgrounds (used here)
 *   - logo-dark.png  — color logo for DARK backgrounds (used by OG)
 * Both have the same content; "dark" has slightly punchier highlights
 * on the metallic NOLAND'S wordmark for visibility on dark surfaces.
 *
 * Sizes tuned to render at consistent heights:
 *   sm — compact chrome (footer, sidebar). Height ≈ 36px.
 *   md — page header nav.                  Height ≈ 48px.
 *   lg — hero / landing.                   Height ≈ 80px.
 *
 * New aspect ratio is 1.40 (was 1.24). Widths bump 4-13px.
 */

import Image from "next/image";
import type { CSSProperties } from "react";

export type WordmarkSize = "sm" | "md" | "lg";
export type WordmarkTone = "ink" | "cream";

// Aspect ratio 2450:1751 ≈ 1.40 — preserved across all size tokens
// so the new logo never distorts.
const SIZE_PX: Record<WordmarkSize, { width: number; height: number }> = {
  sm: { width: 50, height: 36 },
  md: { width: 67, height: 48 },
  lg: { width: 112, height: 80 },
};

export function Wordmark({
  size = "md",
  // tone kept for API compatibility with upstream callers (no-op now —
  // the PNG already has the canonical fire-orange + red color treatment).
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
  const { width, height } = SIZE_PX[size];
  return (
    <Image
      src="/brand/nolands/logo-light.png"
      alt="Noland's Roofing"
      width={width}
      height={height}
      priority={size === "lg"}
      className={className}
      style={{
        display: "inline-block",
        height: `${height}px`,
        width: "auto",
        ...style,
      }}
    />
  );
}

export default Wordmark;
