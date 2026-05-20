/**
 * Client-side reCAPTCHA v3 helper.
 *
 * Loads `https://www.google.com/recaptcha/api.js?render=<site-key>`
 * once per page mount, then exposes `executeRecaptcha(action)` which
 * mints a token bound to a named action. Token gets POSTed to /api/leads
 * as `recaptchaToken` and is verified server-side by `lib/recaptcha.ts`.
 *
 * No-ops cleanly when `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` is unset — the
 * hook returns `null` from execute() and the server-side verifier
 * fail-opens. Same pattern as the rest of the dev-friendly fallbacks
 * in this codebase.
 *
 * The `?render=...` form is reCAPTCHA v3's "auto-binding" mode — it
 * doesn't render any visible widget. Google's badge appears in the
 * bottom-right of every page that loads the script; we hide it via
 * a single CSS rule and rely on the legal-disclosure copy on the form
 * to comply with the brand-attribution requirement.
 */

"use client";

import { useCallback, useEffect, useRef } from "react";

interface GrecaptchaV3 {
  ready(cb: () => void): void;
  execute(siteKey: string, opts: { action: string }): Promise<string>;
}

declare global {
  interface Window {
    grecaptcha?: GrecaptchaV3;
  }
}

const SCRIPT_ID = "voxaris-recaptcha-v3";

function siteKey(): string | null {
  const k = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;
  return k && k.trim() ? k.trim() : null;
}

/**
 * Loads the v3 script once per page and returns an `execute(action)`
 * closure. Safe to call from multiple components — script injection
 * is idempotent.
 */
export function useRecaptcha() {
  const loadedRef = useRef<boolean>(false);

  useEffect(() => {
    const key = siteKey();
    if (!key) return; // No-op when reCAPTCHA isn't configured.
    if (document.getElementById(SCRIPT_ID)) {
      loadedRef.current = true;
      return;
    }
    const s = document.createElement("script");
    s.id = SCRIPT_ID;
    s.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(key)}`;
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
    loadedRef.current = true;
  }, []);

  const execute = useCallback(async (action: string): Promise<string | null> => {
    const key = siteKey();
    if (!key) return null;
    // Wait for the script to define `grecaptcha`. The v3 script is
    // ~30 KB and usually parses well under a second, but on a cold
    // mobile connection we want to be patient before giving up — and
    // never block the customer beyond a reasonable bound.
    const deadline = Date.now() + 8_000;
    while (!window.grecaptcha && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!window.grecaptcha) return null;
    return new Promise<string | null>((resolve) => {
      window.grecaptcha!.ready(async () => {
        try {
          const token = await window.grecaptcha!.execute(key, { action });
          resolve(token);
        } catch (err) {
          console.warn("[recaptcha] execute failed:", err);
          resolve(null);
        }
      });
    });
  }, []);

  return { execute };
}
