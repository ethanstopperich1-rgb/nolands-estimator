import type { Metadata } from "next";
import {
  Geist,
  Geist_Mono,
  Bricolage_Grotesque,
  Space_Grotesk,
  Space_Mono,
  Cormorant_Garamond,
  Hanken_Grotesk,
} from "next/font/google";
import "./globals.css";
import { GradientBackground } from "@/components/ui/gradient-background-4";
import InternalHeader from "@/components/InternalHeader";

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

// metadataBase resolves relative URLs in OG / Twitter card images against a
// real origin so shared links (Slack, iMessage, X) load the social card from
// production instead of the build-host's localhost fallback. Falls through
// to Vercel's auto-injected origins for preview deploys, then to the
// production domain as a last resort.
const metadataBase = process.env.NEXT_PUBLIC_SITE_ORIGIN
  ? new URL(process.env.NEXT_PUBLIC_SITE_ORIGIN)
  : process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? new URL(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
    : process.env.VERCEL_URL
      ? new URL(`https://${process.env.VERCEL_URL}`)
      : new URL("https://pitch.voxaris.io");

// Root-level metadata is the homeowner-facing copy because `/` is the
// customer surface and shared links (Slack, iMessage, X previews) pull
// from here. Dashboard pages can override per-route. Prior copy ("the
// closing tool for roofing teams") was the rep-side pitch — wrong
// audience for the link preview a homeowner sees in their text thread.
export const metadata: Metadata = {
  metadataBase,
  title: "Voxaris · Instant roof estimate from your address",
  description:
    "Get a transparent roof estimate in under a minute. Satellite imagery, your county's records, recent severe-weather history — all in one place. No call required.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${geist.variable} ${geistMono.variable} ${bricolage.variable} ${spaceGrotesk.variable} ${spaceMono.variable} ${cormorant.variable} ${hanken.variable}`}
    >
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
