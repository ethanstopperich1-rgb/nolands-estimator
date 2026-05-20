"use client";

import { useCallback, useEffect, useState } from "react";
import type { Lang } from "@/lib/i18n";

/**
 * Light EN ↔ ES segmented toggle. Customer page only — the rep
 * dashboard stays English (rep team works in English even when
 * leads are Spanish-preferring; this is by design and locked in
 * AGENTS.md telephony / bilingual sections).
 *
 * The toggle is the persistence layer for the bilingual journey:
 *
 *   - On change: writes `vx-lang` cookie (1-year max-age) so the
 *     preference survives navigation + a closed browser tab.
 *   - On change: appends/updates `?lang=` query param so the URL
 *     is shareable AND so any subsequent server-rendered request
 *     (like /r/[publicId] or /api/leads server-side resolution)
 *     can read the language without round-tripping to a cookie.
 *   - Reads on mount: query param wins, then cookie, then default.
 *
 * No history push — uses `replaceState` so the toggle doesn't
 * pollute back-button history with one entry per click. Matches
 * the homepage's "low-friction conversation" feel.
 */

interface Props {
  /** Current lang. Controlled by parent so the page header + form
   *  submits + result-page render all stay in sync. */
  value: Lang;
  /** Called when the user clicks the other language. */
  onChange: (next: Lang) => void;
  /** Override the accent color (defaults to terra). Lets per-office
   *  white-label deployments theme the toggle to their brand. */
  accentColor?: string;
}

export function LanguageToggle({
  value,
  onChange,
  accentColor = "var(--vx-terra, #C76B3F)",
}: Props) {
  const handle = useCallback(
    (next: Lang) => {
      if (next === value) return;

      // Cookie persistence — 1 year max-age, lax samesite so it
      // travels on top-level GET navigations (server-rendered share
      // pages need to see it). Secure + httpOnly:false because the
      // client also reads this same cookie on mount and we want
      // server + client to agree.
      try {
        document.cookie = `vx-lang=${next}; path=/; max-age=31536000; samesite=lax`;
      } catch {
        /* cookies disabled — degrade silently */
      }

      // URL ?lang= reflects current toggle for shareability + so the
      // server picks it up on the next navigation. replaceState not
      // pushState — no history pollution.
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("lang", next);
        window.history.replaceState({}, "", url.toString());
      } catch {
        /* security restrictions on history — degrade silently */
      }

      onChange(next);
    },
    [onChange, value],
  );

  return (
    <div
      role="group"
      aria-label="Language selection"
      className="inline-flex items-center rounded-full overflow-hidden text-eyebrow tracking-wider uppercase select-none"
      style={{
        border: `1px solid ${accentColor}`,
        fontWeight: 600,
        letterSpacing: "0.08em",
      }}
    >
      <button
        type="button"
        aria-pressed={value === "en"}
        onClick={() => handle("en")}
        className="px-3 py-1.5 transition-colors"
        style={{
          background: value === "en" ? accentColor : "transparent",
          color: value === "en" ? "white" : accentColor,
          cursor: value === "en" ? "default" : "pointer",
        }}
      >
        EN
      </button>
      <button
        type="button"
        aria-pressed={value === "es"}
        onClick={() => handle("es")}
        className="px-3 py-1.5 transition-colors"
        style={{
          background: value === "es" ? accentColor : "transparent",
          color: value === "es" ? "white" : accentColor,
          cursor: value === "es" ? "default" : "pointer",
        }}
      >
        ES
      </button>
    </div>
  );
}

/**
 * Hook for client components that need the current language. Reads
 * URL ?lang= first, then `vx-lang` cookie, then defaults to "en".
 * Returns `[lang, setLang]` so consumers can both read AND write.
 *
 * Stays out of React Context on purpose — the customer page has
 * one toggle; passing through props is simpler than a provider.
 */
export function useLanguage(): [Lang, (next: Lang) => void] {
  const [lang, setLang] = useState<Lang>("en");

  // Hydrate from URL + cookie on mount (SSR + first client paint
  // both default to "en"; this kicks in after hydration when window
  // is available). Matches how `resolveLangFromRequest` works on
  // the server so client + server agree.
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const qp = url.searchParams.get("lang");
      if (qp === "en" || qp === "es") {
        setLang(qp);
        return;
      }
      const cookieMatch = /(?:^|;\s*)vx-lang=(en|es)\b/.exec(
        document.cookie ?? "",
      );
      if (cookieMatch) {
        setLang(cookieMatch[1] as Lang);
      }
    } catch {
      /* default "en" — degrade silently */
    }
  }, []);

  return [lang, setLang];
}
