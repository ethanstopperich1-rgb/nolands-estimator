/**
 * Voxaris wordmark — text-only.
 *
 * Replaces every prior usage of `/brand/voxaris-ai-wordmark.png` across
 * the app. Renders lowercase "voxaris" in the brand display serif
 * (DragonEF, falling back to Cormorant via next/font) in the brand
 * navy (`--vx-ink: #0F1B2D`). On dark surfaces (the customer footer
 * + a few PDF chrome rows) we flip to cream.
 *
 * The previous `Wordmark` in app/page.tsx was image-first with a text
 * fallback only on image-load failure. The customer asked for the text
 * version everywhere, so this is the new single source of truth.
 *
 * Sizes:
 *   sm — compact chrome (footer, sidebar, chips). ~22px cap-height.
 *   md — page headers. ~32px.
 *   lg — hero / landing. ~80px.
 *
 * Outside the `.voxaris` brand scope (e.g. inside the dark-theme
 * dashboard chrome before its remap pseudo-applies), the inline color
 * style still pins us to the navy/cream pair so we never inherit a
 * pale-on-cream or pale-on-dark accident.
 */

"use client";

import type { CSSProperties } from "react";

export type WordmarkSize = "sm" | "md" | "lg";
export type WordmarkTone = "ink" | "cream";

const SIZE_PX: Record<WordmarkSize, number> = {
  sm: 22,
  md: 32,
  lg: 80,
};

export function Wordmark({
  size = "md",
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
  const color = tone === "ink" ? "#0F1B2D" : "#ECE3D0";
  return (
    <span
      className={className}
      style={{
        fontFamily:
          'DragonEF, var(--font-cormorant), "Cormorant Garamond", Georgia, serif',
        fontWeight: 500,
        fontSize: `${px}px`,
        lineHeight: 0.95,
        letterSpacing: "-0.022em",
        color,
        display: "inline-block",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      voxaris
    </span>
  );
}

export default Wordmark;
