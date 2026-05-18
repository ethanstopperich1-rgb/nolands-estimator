"use client";

/**
 * Login — Voxaris staff sign-in.
 *
 * Replaces the ugly browser-native HTTP Basic Auth dialog with a styled
 * username + password form. On success, POST /api/auth/staff-login
 * validates against STAFF_AUTH_USER / STAFF_AUTH_PASS and sets an
 * HttpOnly `voxaris-staff` cookie. Middleware reads that cookie and
 * lets the user through to /dashboard (or wherever `?next=` points).
 *
 * Aesthetic: visionOS Liquid Glass — glass-panel-hero on the aurora
 * env. Single-purpose page, no nav or chrome.
 */

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, ArrowRight, Lock, User } from "lucide-react";
import { Wordmark } from "@/components/Wordmark";

function LoginForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const next = sp?.get("next") || "/dashboard";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  // If the user is already signed in (cookie present), bounce them
  // straight through. Avoids the "login form blinks then redirects"
  // flash on a normal navigation.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (/(?:^|; )voxaris-staff=/.test(document.cookie)) {
      router.replace(next);
    }
  }, [next, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password || status === "submitting") return;
    setStatus("submitting");
    setErrorMsg("");
    try {
      const r = await fetch("/api/auth/staff-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        setStatus("error");
        setErrorMsg(
          data.error ?? `Sign-in failed (HTTP ${r.status}). Try again.`,
        );
        return;
      }
      router.replace(next);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Network error");
    }
  };

  return (
    <div
      className="voxaris min-h-[100dvh] flex flex-col items-center justify-center px-4 py-12 relative"
    >
      {/* Subtle ink wash at the bottom — mirrors the .ambient utility on the
          customer surface for the same compositional weight without a card
          glow. */}
      <div className="ambient" aria-hidden="true" />

      <div className="relative z-[1] w-full max-w-[420px] flex flex-col items-center">
        {/* Brand mark — small, sharp, top of the page like the customer site */}
        <div className="mb-10 flex flex-col items-center gap-4">
          <Wordmark size="md" tone="ink" />
          <span className="eyebrow">Operator Console</span>
        </div>

        {/* Paper card — hairline border, 2px radius, faint paper shadow.
            Identical surface treatment to the customer .search-card and
            .result-card. */}
        <div
          className="w-full"
          style={{
            background: "var(--vx-paper)",
            border: "1px solid var(--vx-rule)",
            borderRadius: "var(--vx-radius-card)",
            boxShadow: "0 1px 2px rgba(15, 27, 45, 0.06)",
          }}
        >
          <div className="px-7 sm:px-9 pt-8 sm:pt-10 pb-2">
            <h1
              className="font-serif"
              style={{
                fontSize: "32px",
                fontWeight: 400,
                letterSpacing: "-0.01em",
                lineHeight: 1.15,
                color: "var(--vx-ink)",
              }}
            >
              Welcome <span className="italic">back</span>
            </h1>
            <p
              className="mt-3 text-[13.5px] leading-relaxed"
              style={{ color: "var(--vx-ink-soft)", opacity: 0.8 }}
            >
              Sign in with your Voxaris staff credentials to reach the
              operator console.
            </p>
          </div>

          <form onSubmit={submit} className="px-7 sm:px-9 pt-6 pb-8">
            {/* Stacked rows with hairline dividers — mirrors .slim-row on
                the customer side. No rounded inputs, no focus glow, just
                hairline borders and a 2px sharp focus outline below. */}
            <div
              style={{
                borderTop: "1px solid var(--vx-rule)",
                borderBottom: "1px solid var(--vx-rule)",
              }}
            >
              <label
                className="block"
                style={{
                  padding: "16px 0",
                  borderBottom: "1px solid var(--vx-rule-soft)",
                }}
              >
                <span className="field-label">Username</span>
                <div className="mt-1.5 flex items-center gap-2.5">
                  <User
                    className="w-4 h-4 flex-shrink-0"
                    style={{ color: "var(--vx-muted)" }}
                    strokeWidth={1.5}
                  />
                  <input
                    type="text"
                    autoComplete="username"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="slim-input tabular"
                    placeholder="voxaris"
                  />
                </div>
              </label>
              <label className="block" style={{ padding: "16px 0" }}>
                <span className="field-label">Password</span>
                <div className="mt-1.5 flex items-center gap-2.5">
                  <Lock
                    className="w-4 h-4 flex-shrink-0"
                    style={{ color: "var(--vx-muted)" }}
                    strokeWidth={1.5}
                  />
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="slim-input tabular"
                    placeholder="••••••••"
                  />
                </div>
              </label>
            </div>

            {status === "error" && errorMsg ? (
              <div
                className="mt-5 px-3 py-2.5"
                style={{
                  background: "rgba(199, 107, 63, 0.08)",
                  border: "1px solid rgba(199, 107, 63, 0.35)",
                  color: "var(--vx-terra-dark)",
                  fontSize: "12.5px",
                  lineHeight: 1.5,
                }}
              >
                {errorMsg}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={
                status === "submitting" || !username.trim() || !password
              }
              className="btn-terra mt-6 w-full"
            >
              {status === "submitting" ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Signing in
                </>
              ) : (
                <>
                  Sign in
                  <ArrowRight className="w-3.5 h-3.5 arrow" />
                </>
              )}
            </button>
          </form>
        </div>

        <p
          className="mt-6 text-[11px] leading-relaxed text-center"
          style={{ color: "var(--vx-muted)" }}
        >
          Staff credentials only. Customers reach the public estimator at{" "}
          <a
            href="/"
            className="underline"
            style={{ color: "var(--vx-ink-soft)" }}
          >
            pitch.voxaris.io
          </a>
          .
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  // Wrap in Suspense — useSearchParams() requires it at the page level
  // under the App Router's static-prerender behavior.
  return (
    <Suspense fallback={<div className="lg-env min-h-screen" />}>
      <LoginForm />
    </Suspense>
  );
}
