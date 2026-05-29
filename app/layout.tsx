import type { Metadata, Viewport } from "next";
import {
  Geist,
  Geist_Mono,
  Bricolage_Grotesque,
  Space_Grotesk,
  Space_Mono,
  Cormorant_Garamond,
  Hanken_Grotesk,
  Roboto,
  Poppins,
} from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import { GradientBackground } from "@/components/ui/gradient-background-4";
import InternalHeader from "@/components/InternalHeader";
import {
  buildOrganizationJsonLd,
  buildSoftwareApplicationJsonLd,
  buildWebSiteJsonLd,
  buildServiceJsonLd,
  jsonLdToScriptContent,
} from "@/lib/seo/structured-data";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
});
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});
const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  display: "swap",
  axes: ["opsz", "wdth"],
});
// Nothing-aesthetic typography. Space Grotesk / Mono come from Colophon
// Foundry — same design DNA as Nothing's actual typefaces.
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
  weight: ["300", "400", "500", "700"],
});
const spaceMono = Space_Mono({
  subsets: ["latin"],
  variable: "--font-space-mono",
  display: "swap",
  weight: ["400", "700"],
});
// Patek-inspired editorial pair used by the customer-facing root /.
// Cormorant Garamond for display + italic accents; Hanken Grotesk for
// body text. Variables let the .patek scope opt in without affecting
// any other route's typography.
const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  variable: "--font-cormorant",
  display: "swap",
  weight: ["300", "400", "500", "600"],
  style: ["normal", "italic"],
});
const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-hanken",
  display: "swap",
  weight: ["300", "400", "500", "600", "700"],
});

// ── Noland's Roofing brand fonts (locked May 2026) ────────────────────
//
// Sourced from the live nolandsroofing.com Elementor kit:
//   --e-global-typography-primary-font-family: "Roboto" (600/700 headings)
//   --e-global-typography-text-font-family:    "Helvetica" (body, no webfont → use Inter)
//
// The orange NOLAND'S ROOFING wordmark PNG renders in a heavy
// geometric sans (Montserrat Black / Poppins Black equivalent). We use
// Poppins 900 because it's the closest Google Fonts match to the
// rendered logo letterforms (geometric circular O, spurless G,
// high-crossbar A).
//
// metric-fallback: Inter is metric-compatible with Arial/Helvetica
// (the visitor-side fallback on Windows). Roboto and Poppins use
// next/font's adjustFontFallback (auto) — both have well-defined
// CSS metrics.
const robotoNoland = Roboto({
  subsets: ["latin"],
  variable: "--font-roboto-noland",
  display: "swap",
  weight: ["400", "500", "700", "900"],
});
// Body text → Geist (Vercel's typeface). Replaces Inter (banned by
// taste-skill as the common LLM-default body font) with a metric-
// neutral, well-engineered sans. Geist is already loaded for the
// dashboard; reusing it here keeps the bundle lean.
const poppinsNoland = Poppins({
  subsets: ["latin"],
  variable: "--font-poppins-noland",
  display: "swap",
  // Wider weight range so existing `fontWeight: 300/400/500` inline
  // styles in the customer surface render correctly without changing
  // every consumer. 900 stays the headline/wordmark weight.
  weight: ["300", "400", "500", "600", "700", "800", "900"],
});

// Self-hosted brand fonts via next/font/local. The critical difference vs
// the prior raw @font-face declarations: next/font measures these files
// at build time and generates a metric-adjusted FALLBACK font family
// (ascent, descent, line-gap, size-adjust). The fallback then renders
// the page at exactly the right width/height before the real font
// downloads — when the swap happens, no layout shift. Fixes the
// "vertical → horizontal" hero reflow on first page load.
//
// adjustFontFallback picks the base metric source. Times for the serif
// display (DragonEF reads as a high-contrast Garamond/Didone), Arial for
// the geometric sans-serif (Ambit).
const dragonEF = localFont({
  src: "../public/fonts/DragonEF.otf",
  variable: "--font-dragon",
  display: "swap",
  weight: "400 500",
  style: "normal",
  adjustFontFallback: "Times New Roman",
});
const ambit = localFont({
  src: "../public/fonts/Ambit-SemiBold.ttf",
  variable: "--font-ambit",
  display: "swap",
  weight: "600",
  style: "normal",
  adjustFontFallback: "Arial",
});

// metadataBase resolves relative URLs in OG / Twitter card images against a
// real origin so shared links (Slack, iMessage, X) load the social card from
// production instead of the build-host's localhost fallback. Falls through
// to Vercel's auto-injected origins for preview deploys, then to the
// production domain as a last resort.
// Single-tenant Noland's fork: the canonical homeowner-facing domain is
// estimate.nolandsroofing.com, and it MUST win for OG/Twitter image URLs.
// The prior logic preferred VERCEL_PROJECT_PRODUCTION_URL — which Vercel
// sets to the *.vercel.app project domain (frequently deployment-protected)
// — so shared links resolved og:image to a host preview bots can't fetch,
// and the iMessage/Slack/X thumbnail came up blank. Hardcode the canonical
// domain; an explicit NEXT_PUBLIC_SITE_ORIGIN still overrides it.
const metadataBase = new URL(
  process.env.NEXT_PUBLIC_SITE_ORIGIN || "https://estimate.nolandsroofing.com",
);

// Root-level metadata is the homeowner-facing copy because `/` is the
// customer surface and shared links (Slack, iMessage, X previews) pull
// from here. Dashboard pages can override per-route. Prior copy ("the
// closing tool for roofing teams") was the rep-side pitch — wrong
// audience for the link preview a homeowner sees in their text thread.
const SITE_DESCRIPTION =
  "Get a real roof price in under 30 seconds. We measure your roof from satellite imagery and price it on the spot — free, no obligation, no pressure. Serving Lake, Orange, Volusia, Osceola, Sumter, Polk, Seminole, Flagler, Manatee, and Lee counties.";

export const metadata: Metadata = {
  metadataBase,
  title: "Noland's Roofing · Get your roof priced in 30 seconds",
  description: SITE_DESCRIPTION,
  // Explicit OG/Twitter so shared links (iMessage, Slack, X, WhatsApp) carry
  // a canonical-domain url + the branded card. og:image / twitter:image are
  // auto-attached by Next from app/opengraph-image.tsx + app/twitter-image.tsx,
  // now resolved against the corrected metadataBase (the production domain).
  openGraph: {
    type: "website",
    siteName: "Noland's Roofing",
    url: "/",
    title: "Noland's Roofing · Get your roof priced in 30 seconds",
    description: SITE_DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Noland's Roofing · Get your roof priced in 30 seconds",
    description: SITE_DESCRIPTION,
  },
};

// Explicit viewport for mobile sizing. Next.js auto-injects a default
// in 15, but the 16-canary build pipeline this repo runs on has been
// less predictable about that injection — set it explicitly so phones
// scale to device-width and don't render at 980px desktop width.
// maximumScale=5 (not 1) so the customer can pinch-zoom the painted
// roof image to verify it matches their house, an accessibility +
// trust requirement on a sales surface.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Site-wide JSON-LD — emitted into <head> so AI crawlers + LLM-powered
  // search experiences (ChatGPT search, Perplexity, Google AI Overviews,
  // Claude in Chrome) can ground their answers about Voxaris in
  // structured data instead of guessing from rendered text. Invisible
  // to humans. See lib/seo/structured-data.ts for what each node says.
  // The dangerouslySetInnerHTML pattern is the standard JSON-LD
  // injection method per Schema.org + Google's structured-data docs;
  // each <script type="application/ld+json"> block is a complete,
  // self-contained graph.
  const orgJsonLd = jsonLdToScriptContent(buildOrganizationJsonLd());
  const softwareJsonLd = jsonLdToScriptContent(buildSoftwareApplicationJsonLd());
  const websiteJsonLd = jsonLdToScriptContent(buildWebSiteJsonLd());
  // Service node is emitted at the LAYOUT level (not just the homepage)
  // so /privacy and /terms also carry the offered-service structured
  // data. Closes the AI-SEO audit finding "Service schema only on 1 of
  // 3 pages." The Service @id (`/#service`) is stable across pages so
  // JSON-LD graph dedup handles any redundancy gracefully.
  const serviceJsonLd = jsonLdToScriptContent(buildServiceJsonLd());

  return (
    <html
      lang="en"
      className={`dark ${geist.variable} ${geistMono.variable} ${bricolage.variable} ${spaceGrotesk.variable} ${spaceMono.variable} ${cormorant.variable} ${hanken.variable} ${dragonEF.variable} ${ambit.variable} ${robotoNoland.variable} ${poppinsNoland.variable}`}
    >
      <head>
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger -- JSON-LD is the
          // canonical Schema.org delivery vehicle; content is built
          // server-side from a typed builder with no user input.
          dangerouslySetInnerHTML={{ __html: orgJsonLd }}
        />
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: softwareJsonLd }}
        />
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: websiteJsonLd }}
        />
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: serviceJsonLd }}
        />
      </head>
      <body className="min-h-[100dvh] antialiased relative">
        <GradientBackground />
        {/* Header self-hides on /quote and /p/[id] (customer-facing routes
            render their own dedicated chrome). */}
        <InternalHeader />
        {children}
      </body>
    </html>
  );
}
