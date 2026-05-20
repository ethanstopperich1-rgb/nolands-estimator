/**
 * Brand wordmark — actual Noland's Roofing logo.
 *
 * Replaces the previous text-only placeholder with the real
 * /public/nolands-logo.png — red roof illustration + houses + the
 * fire-orange "NOLAND'S ROOFING" wordmark below. Sourced from
 * https://nolandsroofing.com/wp-content/uploads/2024/06/Transparent-horizontal-sm.png
 * (mirrored locally at /public/nolands-logo.png).
 *
 * Sizes are tuned to render the logo at consistent heights matching
 * the original CSS-text Wordmark it replaces:
 *   sm — compact chrome (footer, sidebar). Height ≈ 36px.
 *   md — page header nav.                  Height ≈ 48px.
 *   lg — hero / landing.                   Height ≈ 80px.
 *
 * The PNG has a 400×322 aspect ratio. Next.js Image preserves it
 * while we drive width to fit each size token.
 */

import Image from "next/image";
import type { CSSProperties } from "react";

export type WordmarkSize = "sm" | "md" | "lg";
export type WordmarkTone = "ink" | "cream";

const SIZE_PX: Record<WordmarkSize, { width: number; height: number }> = {
  sm: { width: 45, height: 36 },
  md: { width: 60, height: 48 },
  lg: { width: 99, height: 80 },
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
      src="/nolands-logo.png"
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
