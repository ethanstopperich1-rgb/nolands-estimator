import type { ReactNode } from "react";
import Link from "next/link";
import LegalTOC from "@/components/ui/legal-toc";

/**
 * Shared chassis for /privacy and /terms.
 *
 * Self-contained — does not depend on the legacy PublicHeader / PublicFooter,
 * which still reference deleted customer routes (/quote, /storms, /embed).
 * Renders in the .voxaris brand scope so the cream + ink + terracotta
 * tokens declared in app/globals.css apply across legal pages.
 */
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="voxaris min-h-[100dvh] flex flex-col">
      {/* Minimal top bar — wordmark + return-home link. No social, no nav. */}
      <header className="relative z-20 pt-7 lg:pt-10">
        <div className="max-w-3xl mx-auto px-6 lg:px-10 flex items-baseline justify-between gap-4">
          <Link href="/" aria-label="Voxaris — home" className="leading-none">
            <span
              className="font-serif tracking-tight"
              style={{
                fontSize: "26px",
                color: "var(--vx-ink)",
                letterSpacing: "-0.02em",
              }}
            >
              Voxaris.
            </span>
          </Link>
          <Link
            href="/"
            className="font-body"
            style={{
              fontSize: "11px",
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "var(--vx-ink-soft)",
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            ← Return to estimator
          </Link>
        </div>
      </header>

      <main
        id="main-content"
        className="relative z-[1] flex-1 px-6 lg:px-10 py-12 lg:py-20"
      >
        <div className="max-w-3xl mx-auto">
          <LegalTOC />
          <article className="legal-article">{children}</article>
        </div>
      </main>

      <footer
        className="relative z-10"
        style={{
          background: "var(--vx-ink)",
          color: "var(--vx-paper)",
          marginTop: "64px",
        }}
      >
        <div className="max-w-3xl mx-auto px-6 lg:px-10 py-12">
          <div className="flex flex-wrap items-baseline justify-between gap-6">
            <Link
              href="/"
              className="leading-none"
              aria-label="Voxaris — home"
            >
              <span
                className="font-serif tracking-tight"
                style={{
                  fontSize: "24px",
                  color: "var(--vx-cream)",
                  letterSpacing: "-0.02em",
                }}
              >
                Voxaris.
              </span>
            </Link>
            <div
              className="flex flex-wrap gap-x-5 gap-y-2"
              style={{
                fontSize: "11px",
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                fontWeight: 600,
                color: "rgba(236, 227, 208, 0.7)",
              }}
            >
              <Link href="/privacy">Privacy</Link>
              <Link href="/terms">Terms</Link>
              <a href="mailto:privacy@voxaris.io">Contact</a>
            </div>
          </div>
          <hr
            style={{
              borderTop: "1px solid rgba(236, 227, 208, 0.08)",
              margin: "32px 0 16px",
            }}
          />
          <div
            className="flex flex-wrap items-center justify-between gap-3"
            style={{
              fontSize: "10.5px",
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "rgba(236, 227, 208, 0.42)",
              fontWeight: 600,
            }}
          >
            <span>© MMXXVI Voxaris, Inc.</span>
            <span>Orlando · Florida</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
