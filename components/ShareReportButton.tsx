"use client";

/**
 * ShareReportButton — CRO P1.2.
 *
 * The /r/[publicId] page exists for one reason: shareability with a
 * spouse, contractor friend, or insurance file. Despite that, the
 * page had NO share affordance — the customer had to copy the URL
 * out of the address bar, which on mobile is effectively a dead
 * end. This component fixes that with a 3-button row:
 *
 *   1. Native Share — uses navigator.share() when available
 *      (Android Chrome, iOS Safari 12.2+, etc.). Opens the OS
 *      share sheet which exposes SMS, email, AirDrop, WhatsApp,
 *      iMessage, and any installed share-receiving apps.
 *   2. Copy Link — fallback for desktop browsers without the
 *      Web Share API. Writes the URL to the clipboard and shows
 *      a "Copied!" toast for 2 seconds.
 *   3. Email — mailto: with pre-filled subject + body so the
 *      customer's mail client opens with the report ready to send.
 *
 * No analytics yet — we'll wire share-method telemetry when GA4
 * events ship (P1.4 from the funnel analysis).
 *
 * Why client-only: navigator.share, clipboard.writeText, and
 * mailto: links all need browser context.
 */

import { useState } from "react";

interface ShareReportButtonProps {
  /** Full absolute URL to the homeowner-share report. */
  shareUrl: string;
  /** Short address used in the share text + email subject. */
  address: string;
  /** Estimate range string ("$28k–$52k" or null when unavailable),
   *  used to make the share text more enticing. */
  estimateRange?: string | null;
  /** Contractor brand name for the share text + subject line. */
  officeName: string;
  /** Optional accent color override — defaults to the var(--vx-terra)
   *  fallback so the button matches the surrounding page. */
  accent?: string;
}

export default function ShareReportButton({
  shareUrl,
  address,
  estimateRange,
  officeName,
  accent = "var(--vx-terra, #c76b3f)",
}: ShareReportButtonProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  // Compose a single share string used by both the Web Share API and
  // the email body. The link is the conversion event we care about —
  // everything else is window-dressing to motivate the click.
  const shareText = estimateRange
    ? `My ${officeName} roof report for ${address} (${estimateRange} estimated). Open the painted measurement here:`
    : `My ${officeName} roof report for ${address}. Open the painted measurement here:`;
  const emailSubject = `My ${officeName} roof report — ${address}`;
  const emailBody = `${shareText}\n\n${shareUrl}\n\n— sent from the ${officeName} estimator`;

  async function handleNativeShare() {
    if (typeof navigator === "undefined" || !navigator.share) {
      // No Web Share API → fall back to clipboard copy.
      return handleCopyLink();
    }
    try {
      await navigator.share({
        title: emailSubject,
        text: shareText,
        url: shareUrl,
      });
    } catch (err) {
      // AbortError = user cancelled the share sheet. That's fine,
      // not an error worth surfacing. Other errors (permission
      // denied, share not supported on this content) fall through to
      // the copy-link path so the customer still has a way to share.
      if (err instanceof Error && err.name === "AbortError") return;
      handleCopyLink();
    }
  }

  async function handleCopyLink() {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard) {
        setCopyState("error");
        return;
      }
      await navigator.clipboard.writeText(shareUrl);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 2000);
    } catch {
      setCopyState("error");
      setTimeout(() => setCopyState("idle"), 2500);
    }
  }

  const buttonBase: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: "10px 14px",
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: "0.02em",
    borderRadius: 8,
    border: `1px solid ${accent}`,
    background: "transparent",
    color: accent,
    cursor: "pointer",
    textDecoration: "none",
    minHeight: 40, // 40px = WCAG 2.1 AA minimum tappable target on mobile
  };

  return (
    <div
      style={{
        display: "grid",
        gap: 8,
        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
        marginTop: 16,
      }}
    >
      <button
        type="button"
        onClick={handleNativeShare}
        style={buttonBase}
        aria-label="Share this roof report"
      >
        <span aria-hidden="true">↗</span>
        Share
      </button>

      <button
        type="button"
        onClick={handleCopyLink}
        style={{
          ...buttonBase,
          // Visual feedback for the copy state — the button changes
          // background briefly so the user sees the action registered
          // even if they're not watching the small text below.
          background:
            copyState === "copied"
              ? `color-mix(in srgb, ${accent} 10%, transparent)`
              : "transparent",
        }}
        aria-label="Copy report link"
      >
        <span aria-hidden="true">⧉</span>
        {copyState === "copied"
          ? "Copied!"
          : copyState === "error"
            ? "Try again"
            : "Copy link"}
      </button>

      <a
        href={`mailto:?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(emailBody)}`}
        style={buttonBase}
        aria-label="Email this roof report"
      >
        <span aria-hidden="true">✉</span>
        Email
      </a>
    </div>
  );
}
