/**
 * /opengraph-image — root-level OG preview card for nolands-estimator.
 *
 * Renders as a 1200×630 PNG via Next.js's `ImageResponse`. This is
 * what shows up when the homeowner-facing URL is shared into iMessage,
 * Slack, WhatsApp, X, LinkedIn, or any modern messenger.
 *
 * Replaces the static `app/opengraph-image.png` that was inherited
 * from the upstream Voxaris fork (silver-house Voxaris Pitch logo on
 * cyan-blue, completely wrong brand for Noland's).
 *
 * Design rules:
 *   - Reads at thumbnail size on a phone preview
 *   - Carries the actual Noland's Roofing logo (not a text wordmark)
 *   - Headline matches the site's H1 promise
 *   - Trust strip + phone number visible
 *   - One fire-orange moment per screen (the accent rule)
 *   - Dark Noland's background to match the live site
 *
 * Why dynamic instead of a flat PNG: cost-free brand consistency. Any
 * future hero-copy or palette change re-renders the OG automatically
 * on next deploy without needing a designer to re-export a PSD.
 */

import { ImageResponse } from "next/og";
import { readFileSync } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const alt = "Noland's Roofing — Get your roof priced in 30 seconds";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Read the actual Noland's logo PNG off disk at build time, encode
// once. `next/og`'s satori renderer needs absolute URLs or data URLs
// for <img> tags — data URLs are the most reliable on Vercel's edge.
function getLogoDataUrl(): string {
  // Switched May 2026 from the 400×322 web-grab to the print-grade
  // 2450×1751 dark-bg variant Destiny shipped on the onboarding
  // form. The "dark" file is identical in content to "light" but
  // has punchier highlights on the metallic NOLAND'S wordmark — the
  // OG background is #07080A deep black, so the brighter highlights
  // are necessary for legibility at small Open Graph render sizes.
  const logoPath = path.join(
    process.cwd(),
    "public",
    "brand",
    "nolands",
    "logo-dark.png",
  );
  const buf = readFileSync(logoPath);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

export default async function OpengraphImage() {
  const logoDataUrl = getLogoDataUrl();

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 80px",
          // Deep black Noland's surface; not pure #000 (taste-skill rule).
          background: "#07080A",
          color: "#E8E9ED",
          fontFamily: "system-ui, -apple-system, Helvetica, sans-serif",
          // Subtle storm-blue + fire-orange ambient washes for atmosphere.
          // satori supports linear/radial gradients via background-image.
          backgroundImage:
            "radial-gradient(ellipse 60% 50% at 100% 100%, rgba(232, 74, 31, 0.18), transparent 65%), radial-gradient(ellipse 70% 50% at 0% 0%, rgba(26, 31, 43, 0.55), transparent 60%)",
        }}
      >
        {/* Top row — logo + eyebrow */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 24,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={logoDataUrl}
            alt=""
            // New high-res logo aspect = 2450:1751 ≈ 1.40 (was 1.24
            // on the old 400×322 web-grab). Height preserved at 116px;
            // width bumped to 162px so the logo doesn't squish.
            width={162}
            height={116}
            style={{ display: "block" }}
          />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color: "#E84A1F",
              }}
            >
              Severe Weather Specialists
            </div>
            <div
              style={{
                fontSize: 16,
                fontWeight: 600,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "rgba(232, 233, 237, 0.55)",
              }}
            >
              Clermont · Orange City · Bradenton · Fort Myers
            </div>
          </div>
        </div>

        {/* Center — the headline does the conversion work */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 24,
            maxWidth: 1040,
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 96,
              fontWeight: 900,
              lineHeight: 0.95,
              letterSpacing: "-0.02em",
              textTransform: "uppercase",
              color: "#E8E9ED",
            }}
          >
            Get your roof priced
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 96,
              fontWeight: 800,
              lineHeight: 0.95,
              letterSpacing: "-0.02em",
              textTransform: "uppercase",
              color: "#E84A1F",
            }}
          >
            in 30 seconds.
          </div>
        </div>

        {/* Bottom row — trust signals + phone */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            gap: 32,
            paddingTop: 32,
            borderTop: "1px solid rgba(232, 233, 237, 0.12)",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "rgba(232, 233, 237, 0.78)",
              }}
            >
              25+ Years · CertainTeed Triple Crown · Licensed
            </div>
            <div
              style={{
                fontSize: 20,
                fontWeight: 500,
                color: "rgba(232, 233, 237, 0.55)",
              }}
            >
              Free, no obligation, no pressure.
            </div>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: 6,
            }}
          >
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color: "rgba(232, 233, 237, 0.5)",
              }}
            >
              Call Noland's
            </div>
            <div
              style={{
                fontSize: 36,
                fontWeight: 700,
                color: "#E8E9ED",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              (352) 242-4322
            </div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
