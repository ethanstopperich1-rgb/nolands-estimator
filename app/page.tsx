"use client";

/**
 * pitch.voxaris.io — customer-facing root.
 *
 * Replaces the old SAM3 pipeline customer flow entirely. Every pixel of
 * roof information on this page comes from the V3 holy-grail truth source:
 *
 *   1. Address via Google Places autocomplete
 *   2. Lead capture (name / email / phone) → POST /api/leads (BotID-guarded)
 *   3. Red draggable pin on a satellite tile → customer confirms building center
 *   4. /api/gemini-roof?pinConfirmed=1 fans out in parallel:
 *        • Solar API → headline sqft + pitch
 *        • Gemini 3 Pro Image → cyan-painted PNG (the visual)
 *        • Gemini 2.5 Flash → rooftop-object JSON (vents, HVAC, chimneys, etc.)
 *      Fallback when Solar undercounts: OSM × Solar-pitch slope factor.
 *      Fallback when Solar 404s: OSM footprint with `pitch=null` (rep enters
 *      manually in /dashboard/estimate).
 *   5. Customer sees the painted image + chips. No SAM, no LiDAR, no
 *      reconciler — those routes are deleted in Phase 4/5.
 *
 * Voxaris brand system v1.0 (cream + ink + terracotta accent,
 * DragonEF + Ambit). All atmosphere lives under the `.voxaris` scope
 * in app/globals.css so the global dark theme (dashboard) is unaffected.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { BRAND_CONFIG } from "@/lib/branding";
import { buildMarketingConsentText } from "@/lib/tcpa-consent";
import Link from "next/link";
import { BotIdClient } from "botid/client";
import { loadGoogle } from "@/lib/google";
import { useRecaptcha } from "@/lib/useRecaptcha";
import { Wordmark as SharedWordmark } from "@/components/Wordmark";
import { ROOFING_FACTS } from "@/lib/roofing-facts";
import {
  calculateTieredPricingWithPenetrations,
  customerRatesForMaterial,
  geminiMaterialToRateKey,
  type TierPrice,
} from "@/lib/pricing/calculate-waste";

type Step = "hero" | "pin" | "loading" | "result" | "error";

interface AddressResolved {
  formatted: string;
  lat: number;
  lng: number;
}

interface V3Response {
  solar: {
    /** Customer-facing total sloped sqft (includes low-slope wings + lanai
     *  cover, excludes pool cages and pergolas). Drives the headline number. */
    sqft: number | null;
    /** Pricing-eligible asphalt-shingle sqft (≥ 12° pitch). Used when
     *  computing Good/Better/Best tier prices so quotes stay calibrated
     *  to asphalt-roof costs even when the headline includes low-slope
     *  area. */
    quotableSqft: number | null;
    footprintSqft: number | null;
    pitchDegrees: number | null;
    segmentCount: number;
    imageryQuality: string | null;
    imageryDate: string | null;
  };
  correction: {
    applied: boolean;
    reason: string;
    solarRawSlopedSqft: number;
    solarRawFootprintSqft: number;
    gisSource: string | null;
    gisFootprintSqft: number | null;
    slopeFactor: number | null;
  } | null;
  tile: {
    centerLat: number;
    centerLng: number;
    zoom: number;
    widthPx: number;
    heightPx: number;
  };
  /** True composite: real Google Static Maps aerial + translucent cyan
   *  overlay tracing the roof polygon Gemini detected. This is what the
   *  customer sees — their actual satellite photo with cyan only on the
   *  measured roof planes. */
  paintedImageBase64: string | null;
  /** Gemini's raw generative paint, pre-composite. Kept for the rep
   *  workbench / debug. Not shown to customers. */
  paintedImageRawBase64?: string | null;
  objects: Array<{
    type: string;
    centerPx: { x: number; y: number };
    bboxPx: { x: number; y: number; width: number; height: number };
    confidence: number;
  }>;
  penetrationTotals: { count: number; perimeterFt: number; areaSqft: number };
  edges: {
    ridgesHipsLf: number | null;
    valleysLf: number | null;
    rakesLf: number | null;
    eavesLf: number | null;
  };
  geminiEdges: {
    ridgesHipsLf: number;
    valleysLf: number;
    rakesLf: number;
    eavesLf: number;
    linesCount: number;
  } | null;
  facets: Array<{
    pitchDegrees: number;
    pitchOnTwelve: string;
    azimuthDegrees: number;
    compassDirection: string;
    slopedSqft: number;
    footprintSqft: number;
  }>;
  derived: {
    stories: number;
    estimatedAtticSqft: number | null;
    predominantCompass: string | null;
    complexity: "simple" | "moderate" | "complex";
  };
  geminiAnalysis: {
    facetCountEstimate: { count: number; complexity: string; confidence: number } | null;
    roofMaterial: { type: string; confidence: number } | null;
    conditionHints: Array<{ hint: string; confidence: number }>;
    visibleDamage: Array<{ kind: string; location_hint?: string; confidence: number }>;
    secondaryStructures: Array<{ kind: string; confidence: number }>;
    siteObstacles: Array<{ kind: string; confidence: number }>;
    apparentAgeBand: { band: string; confidence: number } | null;
  };
  qualitySignals?: {
    compactness: number | null;
    azimuthClusters: number;
    twoPassAgreementRate: number | null;
    filterStats: {
      raw: number;
      afterConfidence: number;
      afterBbox: number;
      afterMask: number;
      afterTwoPass: number;
      afterDedup: number;
      afterCaps: number;
    };
  };
  pricing?: {
    recommendedWastePercent: number;
    wasteBreakdown: {
      fromFacets: number;
      fromAzimuthClusters: number;
      fromCompactness: number;
      fromSteepPitch: number;
      fromSecondaryStructures: number;
    };
    penetrationAddersTotal: number;
    penetrationAdderLines: Array<{
      type: string;
      count: number;
      unit: number;
      subtotal: number;
    }>;
  };
  /** FL statewide cadastral lookup wired in Phase 2/step 2. Drives the
   *  "Why this roof needs attention" customer card. Null when the
   *  property is non-residential, out of state, or Solar didn't return
   *  a building footprint for the FDOR query. */
  parcel: {
    parcelId: string;
    countyNumber: number;
    yearBuilt: number | null;
    effectiveYearBuilt: number | null;
    livingSqft: number | null;
    lotSqft: number | null;
    justValue: number | null;
    buildingCount: number | null;
    lastSale: { priceUsd: number; year: number } | null;
    dorUseCode: string;
    assessmentYear: number | null;
  } | null;
  modelVersion?: string;
  computedAt?: string;
}

/**
 * IEM Local Storm Reports shape returned by /api/storms/recent.
 * Used by the "Why this roof needs attention" card to surface real
 * severe-weather events the homeowner can recognize.
 */
interface RecentStormsResponse {
  events: Array<{
    type: string;
    date: string | null;
    magnitude: number | null;
    magnitudeType: string | null;
    distanceMiles: number | null;
    eventLat?: number;
    eventLng?: number;
    remark?: string;
  }>;
  summary: {
    total: number;
    hailCount: number;
    tornadoCount: number;
    windCount: number;
    maxHailInches: number | null;
    radiusMiles: number;
    daysBack: number;
    source: "iem-lsr";
  };
}

const LOADING_MESSAGES: Array<{ at: number; text: string }> = [
  { at: 0, text: "Fetching satellite imagery…" },
  { at: 3, text: "Measuring the roof…" },
  { at: 7, text: "Identifying the outline…" },
  { at: 13, text: "Tracing roof features…" },
  { at: 19, text: "Detecting vents and penetrations…" },
];

// ROOFING_FACTS imported above — canonical list lives in
// lib/roofing-facts.ts so /dashboard/estimate shares the same source.

/**
 * Customer-readable labels for the rooftop-object enum the Gemini Flash
 * rich-data pass emits. The model returns lowercase_snake_case
 * identifiers (`hvac_unit`, `plumbing_boot`, `satellite_dish`) for
 * downstream pricing math; this map controls what the homeowner
 * actually sees on the "On the roof" chip row.
 *
 * Plural form auto-derives from the count — almost everything just
 * takes "s", and the special cases live in the map.
 *
 * Add new object types by appending to the map. Falling back to the
 * raw enum reads OK if a future type ships before the label catches
 * up (`vent_pipe` → "Vent pipe") rather than crashing.
 */
const OBJECT_TYPE_LABELS: Record<string, { singular: string; plural?: string }> = {
  vent: { singular: "Roof vent" },
  chimney: { singular: "Chimney" },
  hvac_unit: { singular: "HVAC unit" },
  skylight: { singular: "Skylight" },
  plumbing_boot: { singular: "Plumbing boot" },
  satellite_dish: { singular: "Satellite dish", plural: "Satellite dishes" },
  solar_panel: { singular: "Solar panel" },
};

function humanizeObjectType(raw: string, count: number): string {
  const entry = OBJECT_TYPE_LABELS[raw];
  if (entry) {
    if (count === 1) return entry.singular;
    return entry.plural ?? `${entry.singular}s`;
  }
  // Fallback: sentence-case the raw enum so a brand-new type still
  // reads cleanly without a code change.
  const cleaned = raw.replace(/_/g, " ");
  const sentenceCased = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  if (count === 1) return sentenceCased;
  return `${sentenceCased}s`;
}

export default function HomePage() {
  return (
    <main className="voxaris">
      <BotIdClient
        protect={[
          { path: "/api/leads", method: "POST" },
          { path: "/api/gemini-roof", method: "GET" },
          { path: "/api/gemini-roof", method: "POST" },
          { path: "/api/places/autocomplete", method: "GET" },
          { path: "/api/places/details", method: "GET" },
          { path: "/api/storms/recent", method: "GET" },
        ]}
      />
      <VoxarisFlow />
    </main>
  );
}

function VoxarisFlow() {
  const [step, setStep] = useState<Step>("hero");
  const [resolved, setResolved] = useState<AddressResolved | null>(null);
  const [pinLat, setPinLat] = useState<number | null>(null);
  const [leadPublicId, setLeadPublicId] = useState<string | null>(null);
  const [pinLng, setPinLng] = useState<number | null>(null);
  const [result, setResult] = useState<V3Response | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loadingElapsed, setLoadingElapsed] = useState(0);

  // Loading ticker
  useEffect(() => {
    if (step !== "loading") return;
    const t0 = Date.now();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on entering loading step
    setLoadingElapsed(0);
    const id = window.setInterval(() => {
      setLoadingElapsed(Math.floor((Date.now() - t0) / 1000));
    }, 250);
    return () => window.clearInterval(id);
  }, [step]);

  async function confirmPin(): Promise<void> {
    if (pinLat == null || pinLng == null) return;
    setStep("loading");
    setErrorMsg(null);
    setResult(null);
    try {
      // Cache by lat/lng — the server keys CACHE_SCOPE_V3 + lat,lng,
      // and bumps the scope whenever the pipeline changes shape (most
      // recently → "v3-composite" in commit 767c233). That means the
      // customer hitting the same pin a second time gets the cached
      // ~50ms response instead of paying for a fresh 25-50s Gemini
      // pass + Pro Image call (~$0.087). Prior behavior forced
      // skipCache=1 on EVERY customer submit, which (a) burned that
      // cost on every refresh and (b) didn't actually solve the stale-
      // results worry the old comment described — that's what
      // CACHE_SCOPE_V3 bumps are for.
      //
      // Reps can still force a fresh pass via the "Regenerate" button
      // in the dashboard, which hits the same endpoint with
      // skipCache=1.
      //
      // leadPublicId triggers server-side persistence via waitUntil()
      // so the rep workbench can render "See report" instantly from
      // the leads.roof_v3_json column without re-running the pipeline.
      const params = new URLSearchParams({
        lat: String(pinLat),
        lng: String(pinLng),
        pinConfirmed: "1",
      });
      if (leadPublicId) params.set("leadPublicId", leadPublicId);
      const res = await fetch(`/api/gemini-roof?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        // Server logs already capture status + body; surface a
        // human-readable message to the homeowner. Raw "Estimate
        // service 502: <stack>" was the prior behavior and read as
        // broken even when the underlying issue was transient.
        const friendly = friendlyEstimateError(res.status);
        console.warn(
          "[customer] estimate_failed",
          res.status,
          (await res.text().catch(() => "")).slice(0, 300),
        );
        throw new Error(friendly);
      }
      const data = (await res.json()) as V3Response;
      setResult(data);
      setStep("result");
    } catch (err) {
      // Network-level failure (DNS / abort / offline) lands here too.
      // Detect and message specifically so the customer doesn't see
      // "TypeError: Failed to fetch."
      const msg =
        err instanceof Error && err.message ? err.message : String(err);
      const isNetwork = /failed to fetch|networkerror|load failed/i.test(msg);
      setErrorMsg(
        isNetwork
          ? "We couldn't reach our servers. Check your connection and try again."
          : msg,
      );
      setStep("error");
    }
  }

  /**
   * Map HTTP status codes from the V3 pipeline into copy a homeowner can
   * actually read. The customer can't act on "502 bad gateway" — they
   * can act on "the imagery service is having a moment, try again."
   *
   * Server still logs the raw status/body for our debugging; this only
   * controls what's shown on the customer-facing error screen.
   */
  function friendlyEstimateError(status: number): string {
    if (status === 422) {
      return "We couldn't identify a roof at that exact pin. Try re-pinning the center of the building.";
    }
    if (status === 429) {
      return "Our roof-measurement service is busy right now. Please wait a minute and try again.";
    }
    if (status === 503) {
      return "Our roof-measurement service is briefly offline. We'll be back in a minute — please retry.";
    }
    if (status >= 500) {
      return "Something went wrong on our side measuring this roof. Our team has been notified — please retry in a moment.";
    }
    if (status >= 400) {
      return "We couldn't measure that address. Try starting over with the full street address.";
    }
    return "Something unexpected happened. Please retry.";
  }

  function startOver(): void {
    setStep("hero");
    setResolved(null);
    setPinLat(null);
    setLeadPublicId(null);
    setPinLng(null);
    setResult(null);
    setErrorMsg(null);
  }

  return (
    <>
      {step === "hero" && (
        <HeroScreen
          onAddressResolved={(addr, leadId) => {
            setResolved(addr);
            setLeadPublicId(leadId ?? null);
            setPinLat(addr.lat);
            setPinLng(addr.lng);
            setStep("pin");
          }}
        />
      )}
      {step === "pin" && resolved && (
        <PinScreen
          resolved={resolved}
          pinLat={pinLat}
          pinLng={pinLng}
          onPinMove={(lat, lng) => {
            setPinLat(lat);
            setPinLng(lng);
          }}
          onBack={startOver}
          onConfirm={confirmPin}
        />
      )}
      {step === "loading" && (
        <LoadingScreen elapsed={loadingElapsed} message={loadingMessageFor(loadingElapsed)} />
      )}
      {step === "result" && result && resolved && (
        <ResultScreen
          result={result}
          resolved={resolved}
          leadPublicId={leadPublicId}
          onRePin={() => setStep("pin")}
          onStartOver={startOver}
        />
      )}
      {step === "error" && (
        <ErrorScreen message={errorMsg ?? "Something went wrong."} onRetry={startOver} />
      )}
    </>
  );
}

function loadingMessageFor(elapsed: number): string {
  return LOADING_MESSAGES.filter((m) => m.at <= elapsed).pop()?.text ?? LOADING_MESSAGES[0].text;
}

/** Live-format a phone input as the customer types: "(555) 555-5555".
 *  Strips non-digits, caps at 10 digits, then re-builds the standard
 *  US grouping. Tolerates partial input — no flicker at the seams. */
function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 10);
  if (digits.length === 0) return "";
  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

// ─── Hero (Voxaris brand) ───────────────────────────────────────────────

function HeroScreen({
  onAddressResolved,
}: {
  onAddressResolved: (addr: AddressResolved, leadId: string | null) => void;
}) {
  const addrRef = useRef<HTMLInputElement>(null);
  const [resolvedAddr, setResolvedAddr] = useState<AddressResolved | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  // Marketing consent gates lead capture + the SMS intro. The separate
  // voice consent lives on the result page now — captured after the
  // customer sees their estimate, before any automated voice call is
  // placed (TCPA "prior express written consent" requirement met).
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [officeSlug, setOfficeSlug] = useState("nolands");
  const [sellerName, setSellerName] = useState(BRAND_CONFIG.companyName);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const marketingDisclosure = useMemo(
    () => buildMarketingConsentText(sellerName),
    [sellerName],
  );

  useEffect(() => {
    const slug =
      new URLSearchParams(window.location.search).get("office")?.trim().toLowerCase() ||
      "nolands";
    setOfficeSlug(slug);
    let cancelled = false;
    fetch(`/api/office/branding?office=${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { displayName?: string } | null) => {
        if (!cancelled && data?.displayName) setSellerName(data.displayName);
      })
      .catch(() => {
        /* Branding API optional in dev — fall back to env company name. */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // reCAPTCHA v3 — invisible, score-based. Layered on top of BotID.
  // Token gets minted at submit time with action="submit_lead" and
  // verified server-side by /api/leads. No-op when
  // NEXT_PUBLIC_RECAPTCHA_SITE_KEY isn't set (dev / preview).
  const { execute: executeRecaptcha } = useRecaptcha();

  // Google Places autocomplete
  useEffect(() => {
    if (!addrRef.current) return;
    let cancelled = false;
    let ac: google.maps.places.Autocomplete | null = null;
    loadGoogle()
      .then((g) => {
        if (cancelled || !addrRef.current) return;
        ac = new g.maps.places.Autocomplete(addrRef.current, {
          types: ["address"],
          componentRestrictions: { country: "us" },
          fields: ["formatted_address", "geometry"],
        });
        ac.addListener("place_changed", () => {
          const place = ac!.getPlace();
          const loc = place.geometry?.location;
          if (!loc) return;
          setResolvedAddr({
            formatted: place.formatted_address ?? addrRef.current!.value,
            lat: loc.lat(),
            lng: loc.lng(),
          });
        });
      })
      .catch(() => {
        /* Maps unavailable — user can still type freely; we'll geocode on submit if needed. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setFormError(null);
    if (!resolvedAddr) {
      setFormError("Please pick your address from the dropdown.");
      return;
    }
    if (!name.trim() || !email.trim() || !phone.trim()) {
      setFormError("Name, email, and phone are required.");
      return;
    }
    if (!marketingConsent) {
      setFormError("Please confirm the first consent to receive your estimate.");
      return;
    }
    setSubmitting(true);
    try {
      // Lead capture — BotID validates server-side via the Provider above.
      // marketingConsent is REQUIRED and gates the SMS intro + email.
      // Voice consent is captured later on the result page as its own
      // explicit action, then POSTed to /api/leads/[publicId]/voice-consent.
      //
      // reCAPTCHA v3 token minted here. If Google's script never
      // finished loading (slow connection, blocked extension), this
      // resolves to null and the server-side verifier will reject —
      // unless reCAPTCHA isn't configured at all, in which case both
      // sides no-op gracefully.
      const recaptchaToken = await executeRecaptcha("submit_lead");
      let leadPublicId: string | null = null;
      try {
        const res = await fetch("/api/leads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            email: email.trim(),
            phone: phone.trim(),
            address: resolvedAddr.formatted,
            lat: resolvedAddr.lat,
            lng: resolvedAddr.lng,
            source: "pitch.voxaris.io",
            office: officeSlug,
            marketingConsent: true,
            voiceConsent: false,
            recaptchaToken,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { leadId?: string };
          if (typeof data.leadId === "string") leadPublicId = data.leadId;
        }
      } catch {
        /* Lead capture failure must not block the estimate. */
      }
      onAddressResolved(resolvedAddr, leadPublicId);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex flex-col min-h-[100dvh]">
      <section className="relative overflow-hidden">
        <div className="ambient" />
        <CrescentSvg />

        {/* Top bar — small wordmark in the corner, rep Login link
            opposite. The big VOXARIS announcement happens via the
            serif headline below; the header is just a brand anchor +
            rep door. Per brand §06 "whitespace is a feature" — no nav
            links other than the one rep Login. */}
        <header className="relative z-20 pt-6 lg:pt-7">
          <div className="max-w-7xl mx-auto px-6 lg:px-10 flex items-center justify-between">
            <Link
              href="/"
              className="leading-none"
              aria-label="Voxaris — home"
            >
              {/* Header wordmark now matches the footer's `size="lg"`
                  for symmetric brand bookends. Earlier corner-mark
                  treatment (size="sm" 32px) read as a tiny chip; the
                  footer carries the brand at 140px so the header
                  should too. */}
              <Wordmark size="lg" tone="ink" />
            </Link>
            <Link
              href="/login"
              className="leading-none inline-flex items-center gap-2 transition-colors"
              style={{
                fontFamily: "var(--vx-font-ui)",
                fontWeight: 600,
                fontSize: "11px",
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color: "var(--vx-ink-soft)",
                padding: "8px 14px",
                border: "1px solid var(--vx-rule)",
                borderRadius: 0,
              }}
              aria-label="Rep login"
            >
              Login
              <span aria-hidden="true" style={{ fontWeight: 400 }}>
                →
              </span>
            </Link>
          </div>
        </header>

        {/* Hero copy */}
        <div className="relative z-10 max-w-5xl mx-auto px-6 lg:px-10 pt-24 lg:pt-32 pb-16 lg:pb-20 text-center">
          <OrnamentSvg />
          <h1
            className="rise font-serif tracking-tight mx-auto"
            data-d="1"
            style={{
              fontSize: "clamp(54px, 8.2vw, 120px)",
              lineHeight: 0.96,
              fontWeight: 500,
              color: "var(--vx-ink)",
              maxWidth: "14ch",
            }}
          >
            What will it cost
            <span
              className="block italic"
              style={{ fontWeight: 300, color: "var(--vx-ink-soft)" }}
            >
              to replace your roof?
            </span>
          </h1>
          <p
            className="rise mt-10 mx-auto"
            data-d="2"
            style={{
              maxWidth: "60ch",
              fontSize: "19px",
              lineHeight: 1.6,
              color: "var(--vx-ink-soft)",
              fontWeight: 300,
            }}
          >
            We measure your roof from satellite imagery and price it in thirty
            seconds. Proprietary model. A real number.{" "}
            <span className="font-serif italic" style={{ color: "var(--vx-ink)" }}>
              No calls until you ask.
            </span>
          </p>
        </div>

        {/* Form */}
        <div className="relative z-10 max-w-4xl mx-auto px-6 lg:px-10 pb-24 lg:pb-32">
          <form
            className="rise search-card"
            data-d="4"
            onSubmit={handleSubmit}
            noValidate
          >
            <span className="marker absolute -top-[3px] -left-[3px]" aria-hidden="true" />
            <span className="marker absolute -top-[3px] -right-[3px]" aria-hidden="true" />
            <span className="marker absolute -bottom-[3px] -left-[3px]" aria-hidden="true" />
            <span className="marker absolute -bottom-[3px] -right-[3px]" aria-hidden="true" />

            <div className="addr-row">
              <span className="flex items-center justify-center" aria-hidden="true">
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  style={{ color: "var(--vx-ink-soft)", opacity: 0.6 }}
                >
                  <circle cx="11" cy="11" r="7" />
                  <path d="M20 20l-3.5-3.5" />
                </svg>
              </span>
              <label htmlFor="voxaris-address-input" className="sr-only">
                Property street address
              </label>
              <input
                ref={addrRef}
                id="voxaris-address-input"
                type="text"
                className="addr-input"
                placeholder="Begin typing your address…"
                autoComplete="street-address"
                aria-label="Property street address"
                required
                spellCheck={false}
              />
              <span
                className="tabular hidden md:inline"
                style={{
                  fontSize: "10.5px",
                  letterSpacing: "0.20em",
                  textTransform: "uppercase",
                  color: "var(--vx-muted)",
                }}
              >
                ≈ 30 sec
              </span>
            </div>

            {/* Contact row — matches the address-row pattern: no visible
                label, just a soft placeholder that fades when the user
                starts typing. The example values ("Eleanor Whitaker",
                "(407) 555-0117") had two problems: (1) they read as
                placeholder data on screenshots / fake field hints, and
                (2) some users mistook them for pre-filled text. Generic
                "Your name / Your email / Your number" mirrors the
                "Begin typing your address…" tone the row above uses.

                Labels kept in the DOM as sr-only for screen readers
                + form autofill heuristics. Visually hidden only. */}
            <div className="slim-row">
              <div className="slim-cell">
                <label htmlFor="nm" className="sr-only">
                  Full name
                </label>
                <input
                  id="nm"
                  className="slim-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                  required
                />
              </div>
              <div className="slim-cell">
                <label htmlFor="em" className="sr-only">
                  Email address
                </label>
                <input
                  id="em"
                  type="email"
                  className="slim-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Your email"
                  autoComplete="email"
                  required
                />
              </div>
              <div className="slim-cell">
                <label htmlFor="ph" className="sr-only">
                  Phone number
                </label>
                <input
                  id="ph"
                  className="slim-input tabular"
                  value={phone}
                  onChange={(e) => setPhone(formatPhone(e.target.value))}
                  placeholder="Your number"
                  inputMode="tel"
                  autoComplete="tel"
                  maxLength={14}
                  required
                />
              </div>
            </div>

            {/* Consent 1 — required. Lead capture + SMS intro. */}
            <div className="px-[22px] py-4" style={{ borderBottom: "1px solid var(--vx-rule-soft)" }}>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={marketingConsent}
                  onChange={(e) => setMarketingConsent(e.target.checked)}
                  required
                />
                <span style={{ fontSize: "12px", color: "var(--vx-ink-soft)", lineHeight: 1.6 }}>
                  {marketingDisclosure.replace(
                    "See our Privacy Policy at /privacy and Terms of Service at /terms.",
                    "",
                  ).trim()}{" "}
                  <Link
                    href="/privacy"
                    className="underline"
                    style={{ textDecorationColor: "var(--vx-muted)", textUnderlineOffset: "2px" }}
                  >
                    Privacy Policy
                  </Link>{" "}
                  ·{" "}
                  <Link
                    href="/terms"
                    className="underline"
                    style={{ textDecorationColor: "var(--vx-muted)", textUnderlineOffset: "2px" }}
                  >
                    Terms of Service
                  </Link>
                  .{" "}
                  {/* reCAPTCHA brand-attribution disclosure. Required by
                      Google when we hide the corner badge via the CSS
                      rule in app/globals.css. See:
                      https://developers.google.com/recaptcha/docs/faq */}
                  <span style={{ color: "var(--vx-muted)" }}>
                    This site is protected by reCAPTCHA and the Google{" "}
                    <a
                      href="https://policies.google.com/privacy"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                      style={{ textDecorationColor: "var(--vx-muted)", textUnderlineOffset: "2px" }}
                    >
                      Privacy Policy
                    </a>{" "}
                    and{" "}
                    <a
                      href="https://policies.google.com/terms"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                      style={{ textDecorationColor: "var(--vx-muted)", textUnderlineOffset: "2px" }}
                    >
                      Terms of Service
                    </a>{" "}
                    apply.
                  </span>
                </span>
              </label>
            </div>

            {/* Voice consent intentionally NOT in this form — it now
                lives on the result page as a post-estimate "Get a rep
                to my door" action. TCPA compliance: prior express
                written consent for an automated voice call must be
                obtained before the call is placed, but it does NOT
                have to be obtained at the same step as the SMS
                consent. Capturing it after the customer has seen
                their estimate is a stronger consent signal (they're
                acting on a real piece of value, not a blanket
                opt-in). */}

            <div className="foot-row">
              <div
                className="flex items-center gap-3"
                style={{
                  fontSize: "10.5px",
                  letterSpacing: "0.20em",
                  textTransform: "uppercase",
                  color: "var(--vx-muted)",
                }}
              >
                <span className="marker" aria-hidden="true" />
                <span>Non-binding estimate · We never sell your info</span>
              </div>
              <button type="submit" className="btn-terra" disabled={submitting}>
                {submitting ? "Loading…" : "See my estimate"}
                <span className="arrow" aria-hidden="true">→</span>
              </button>
            </div>

            {formError && (
              <div
                className="px-[22px] py-3"
                style={{
                  fontSize: "13px",
                  color: "#8a2c2c",
                  borderTop: "1px solid var(--vx-rule-soft)",
                  background: "rgba(138, 44, 44, 0.06)",
                }}
              >
                {formError}
              </div>
            )}
          </form>
        </div>

        <SkylineSvg />
        <hr className="hair-strong" />
      </section>

      <VoxarisFooter />
    </div>
  );
}

// ─── Pin-confirm screen ─────────────────────────────────────────────────

function PinScreen({
  resolved,
  pinLat,
  pinLng,
  onPinMove,
  onBack,
  onConfirm,
}: {
  resolved: AddressResolved;
  pinLat: number | null;
  pinLng: number | null;
  onPinMove: (lat: number, lng: number) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const mapElRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);

  useEffect(() => {
    if (!mapElRef.current) return;
    let cancelled = false;
    loadGoogle().then((g) => {
      if (cancelled || !mapElRef.current) return;
      const center = { lat: resolved.lat, lng: resolved.lng };
      const map = new g.maps.Map(mapElRef.current, {
        center,
        // Zoom 21 matches `PIN_TILE_ZOOM` on the measurement pipeline
        // (`app/api/gemini-roof/route.ts`). When the pin map was 20,
        // customers confirmed their roof in a wider frame than what got
        // measured — the building looked smaller at confirm time, then
        // the result screen showed a tighter crop, and the framing
        // mismatch contributed to "is this even my house?" reactions
        // on complex properties. Match the framing exactly so what the
        // customer sees at confirm IS what the pipeline measures.
        zoom: 21,
        mapTypeId: g.maps.MapTypeId.SATELLITE,
        tilt: 0,
        disableDefaultUI: true,
        gestureHandling: "greedy",
        zoomControl: true,
        keyboardShortcuts: false,
      });
      mapRef.current = map;
      const marker = new g.maps.Marker({
        position: { lat: pinLat ?? resolved.lat, lng: pinLng ?? resolved.lng },
        map,
        draggable: true,
        cursor: "grab",
        title: "Drag to the center of the roof",
        animation: g.maps.Animation.DROP,
      });
      markerRef.current = marker;
      marker.addListener("dragend", () => {
        const pos = marker.getPosition();
        if (!pos) return;
        onPinMove(pos.lat(), pos.lng());
      });
    });
    return () => {
      cancelled = true;
      markerRef.current?.setMap(null);
      markerRef.current = null;
    };
    // resolved address never changes inside this step — re-init only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative min-h-[100dvh] flex flex-col">
      <div className="ambient" />
      <PinHeader onBack={onBack} />

      <div className="relative z-10 max-w-3xl mx-auto px-6 lg:px-10 pt-10 lg:pt-14 pb-10 w-full">
        <div className="text-center">
          <div className="eyebrow mb-3">Step 02 · Confirm your roof</div>
          <h2
            className="font-serif tracking-tight"
            style={{
              fontSize: "clamp(36px, 5vw, 56px)",
              lineHeight: 1.04,
              fontWeight: 500,
              color: "var(--vx-ink)",
            }}
          >
            Is this the right roof?
          </h2>
          <p
            className="mx-auto mt-4"
            style={{
              maxWidth: "52ch",
              fontSize: "16px",
              lineHeight: 1.65,
              color: "var(--vx-ink-soft)",
              fontWeight: 300,
            }}
          >
            Drag the pin so it sits in the{" "}
            <span style={{ color: "var(--vx-ink)" }}>center</span> of your roof.
            That tells our model exactly which building to measure.
          </p>
          <p
            className="mx-auto mt-3 font-serif italic"
            style={{ fontSize: "15px", color: "var(--vx-ink-soft)" }}
          >
            {resolved.formatted}
          </p>
        </div>

        <div className="result-card mt-10 overflow-hidden" style={{ aspectRatio: "16 / 11" }}>
          <span className="marker absolute -top-[3px] -left-[3px]" aria-hidden="true" />
          <span className="marker absolute -top-[3px] -right-[3px]" aria-hidden="true" />
          <span className="marker absolute -bottom-[3px] -left-[3px]" aria-hidden="true" />
          <span className="marker absolute -bottom-[3px] -right-[3px]" aria-hidden="true" />
          <div ref={mapElRef} className="w-full h-full" />
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
          <button
            type="button"
            onClick={onBack}
            style={{
              fontSize: "12px",
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "var(--vx-ink-soft)",
              fontWeight: 500,
              background: "none",
              border: 0,
              cursor: "pointer",
              padding: "10px 0",
            }}
          >
            ← Different address
          </button>
          <button type="button" className="btn-terra" onClick={onConfirm}>
            Confirm building center
            <span className="arrow" aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Loading screen ─────────────────────────────────────────────────────

function LoadingScreen({ elapsed, message }: { elapsed: number; message: string }) {
  // Asymptotic progress curve — climbs fast early, slows toward 99%, never
  // hits 100% until the response actually returns and the parent flips to
  // the result step. Target shape: ~50% at 12s, ~80% at 30s, ~95% at 60s.
  // This eliminates the "bar finishes but we're still waiting" awkwardness
  // and pads the perceived wait when Pro Image runs long (25–50s typical).
  const pct = Math.min(99, Math.round(100 * (1 - Math.exp(-elapsed / 22))));

  // Shuffle the facts once per loading session so consecutive visitors
  // (and the same visitor on repeat estimates) don't see identical
  // copy. Lazy useState initializer keeps the shuffle pure-from-React's
  // POV (the render itself never calls Math.random) — `useMemo` would
  // trip the react-hooks/purity rule.
  const [shuffled] = useState<string[]>(() => {
    const arr = [...ROOFING_FACTS];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  });

  // Advance the fact every ~7 sec — paint-only mode runs ~25–50s, so
  // we want 4–7 facts to cycle through without burning the whole
  // shuffle before the response lands. Cross-fade keyed on factIndex.
  const FACT_INTERVAL = 7;
  const factIndex = Math.min(
    shuffled.length - 1,
    Math.floor(elapsed / FACT_INTERVAL),
  );
  const fact = shuffled[factIndex];

  return (
    <div className="relative min-h-[100dvh] flex flex-col">
      <div className="ambient" />
      <PinHeader />

      {/* Fully centered loading layout — fact is the hero, progress
          bar sits directly under it. No headline above; the eyebrow
          status line is the only chrome. */}
      <div className="relative z-10 flex-1 flex items-center justify-center px-6 lg:px-10 py-10 w-full">
        <div
          className="w-full mx-auto text-center flex flex-col items-center justify-center"
          style={{ maxWidth: "880px" }}
        >
          {/* Status line — small, muted, sits well above the fact. */}
          <div className="eyebrow mb-10">Measuring · {message}</div>

          {/* Fact — the hero. Cross-fade keyed on index. */}
          <div
            key={factIndex}
            className="rise w-full"
            style={{ maxWidth: "780px" }}
            data-d="1"
          >
            <p
              className="font-serif mx-auto"
              style={{
                fontSize: "clamp(28px, 4.4vw, 44px)",
                lineHeight: 1.3,
                fontWeight: 400,
                color: "var(--vx-ink)",
                fontStyle: "italic",
              }}
            >
              {fact}
            </p>
          </div>

          {/* Progress bar — thicker, terracotta accent, sized to match
              the editorial weight of the fact. */}
          <div
            className="mt-12 w-full"
            style={{
              maxWidth: "640px",
              height: "3px",
              background: "var(--vx-rule)",
              position: "relative",
              overflow: "hidden",
              borderRadius: "2px",
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: 0,
                width: `${pct}%`,
                background: "var(--vx-terra)",
                transition: "width 0.4s ease",
              }}
            />
          </div>
          <div className="mt-3 flex items-center justify-center">
            <span
              className="tabular"
              style={{
                fontSize: "11px",
                letterSpacing: "0.22em",
                textTransform: "uppercase",
                color: "var(--vx-muted)",
                fontWeight: 600,
              }}
            >
              {Math.min(100, pct)}%
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Result screen ──────────────────────────────────────────────────────

function ResultScreen({
  result,
  resolved,
  leadPublicId,
  onRePin,
  onStartOver,
}: {
  result: V3Response;
  resolved: AddressResolved;
  leadPublicId: string | null;
  onRePin: () => void;
  onStartOver: () => void;
}) {
  const { solar, paintedImageBase64, objects, facets, derived, geminiEdges, edges } = result;
  const sqft = solar.sqft;
  const pitch = solar.pitchDegrees;
  const pitchOn12 = pitch != null && pitch > 0
    ? `${Math.max(1, Math.round(Math.tan((pitch * Math.PI) / 180) * 12))}/12`
    : null;

  // Edges are rep-only data and the Solar classifier on its own
  // (without Gemini line passes) misfires on simple gables, returning
  // patterns like 0/0/562/642. Not shown on the customer page.
  void geminiEdges;
  void edges;

  // Material-aware customer pricing: read Gemini's detected material
  // and scale tier rates so a concrete-tile or metal roof gets quoted
  // in the right ballpark instead of always at architectural-shingle
  // prices. Falls back to architectural shingle when material is null
  // or low-confidence — better to under-price slightly than over-price
  // on a guess.
  const detectedMaterialKey =
    geminiMaterialToRateKey(result.geminiAnalysis.roofMaterial?.type) ?? null;
  const detectedMaterialConfidence =
    result.geminiAnalysis.roofMaterial?.confidence ?? 0;
  // Material confidence gate. Wrong material → wildly wrong tier prices
  // (metal is ~3× asphalt, tile is ~2.5×). Tighter threshold for the
  // premium materials so a low-confidence "metal" guess doesn't quote
  // the customer at 3× the right price. Architectural shingle is the
  // safe default — falling back to it on a low-confidence guess
  // under-prices slightly (~$0.50/sqft) instead of over-pricing wildly.
  const MATERIAL_CONFIDENCE_FLOORS: Record<string, number> = {
    metal: 0.85,
    standing_seam: 0.85,
    clay_tile: 0.85,
    concrete_tile: 0.80,
    slate: 0.90,
    wood_shake: 0.85,
    asphalt_shingle: 0.55, // baseline — fine to default to this
  };
  const requiredFloor =
    detectedMaterialKey != null
      ? MATERIAL_CONFIDENCE_FLOORS[detectedMaterialKey] ?? 0.75
      : 0.75;
  const pricingMaterialKey =
    detectedMaterialConfidence >= requiredFloor ? detectedMaterialKey : null;
  const pricingMaterial = customerRatesForMaterial(pricingMaterialKey);

  // Pricing — Good / Better / Best tiers with three layers stacked:
  //   1. Material-aware tier scaling (concrete-tile / metal multiplier)
  //   2. Server-provided geometric waste % (azimuth clusters +
  //      compactness + facets, not the old flat 12%)
  //   3. Per-fixture penetration adders for the chimneys / skylights
  //      that survived the six-guard filter chain
  // The rep workbench has the detailed waste breakdown; this is the
  // customer-visible quote.
  // Pricing-eligible sqft. We deliberately price on `quotableSqft` (the
  // ≥ 12° asphalt-shingle portion) rather than the wider headline `sqft`
  // so the tier dollars stay calibrated to asphalt costs even when the
  // headline includes a low-slope addition or lanai cover. Falls back
  // to the headline sqft on responses that predate the split (e.g.
  // cached estimates rendered before the May 18 fix), or when the V3
  // pipeline routed through the OSM correction (MEDIUM/LOW imagery) —
  // both cases mean `quotableSqft === sqft` already.
  const pricingSqft = result.solar.quotableSqft ?? sqft;
  const tiers: TierPrice[] | null = useMemo(() => {
    if (pricingSqft == null) return null;
    const wastePercent = result.pricing?.recommendedWastePercent ?? 12;
    const waste = {
      suggestedPercent: wastePercent,
      complexityScore: 0,
      breakdown: {
        fromFacets: 0,
        fromValleys: 0,
        fromRidgesHips: 0,
        fromSteepPitch: 0,
      },
      table: [] as Array<{ percent: number; totalSquares: number }>,
    };
    return calculateTieredPricingWithPenetrations(
      pricingSqft,
      waste,
      objects,
      pricingMaterialKey,
    ).tiers;
  }, [pricingSqft, result.pricing, objects, pricingMaterialKey]);

  const objectCounts = objects.reduce<Record<string, number>>((acc, o) => {
    acc[o.type] = (acc[o.type] ?? 0) + 1;
    return acc;
  }, {});

  // "Why this roof needs attention" data sources — both load
  // asynchronously after the V3 result arrives so the customer sees the
  // measurement instantly and the narrative card flows in below the
  // fold a moment later. Parcel data ships INSIDE the V3 response (no
  // extra fetch); storms come from /api/storms/recent.
  const parcel = result.parcel;
  const [storms, setStorms] = useState<RecentStormsResponse | null>(null);
  // Tracks whether the storms fetch is in flight. Used by WhyNowCard to
  // render parcel data immediately and show a skeleton in the weather
  // column while the IEM mirror responds — instead of the whole card
  // popping in late and causing a layout jump as the customer is reading.
  const [stormsLoading, setStormsLoading] = useState(true);
  useEffect(() => {
    // Query the IEM LSR mirror around the tile center (already the
    // building centroid for pin-confirmed flows). 25mi radius, 365 days
    // back — wide enough to capture "the storm that prompted this
    // estimate" even when the customer is researching weeks later.
    const ctrl = new AbortController();
    const params = new URLSearchParams({
      lat: String(result.tile.centerLat),
      lng: String(result.tile.centerLng),
      radiusMiles: "25",
      daysBack: "365",
    });
    setStormsLoading(true);
    fetch(`/api/storms/recent?${params.toString()}`, {
      signal: ctrl.signal,
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: RecentStormsResponse | null) => {
        if (d && d.summary) setStorms(d);
      })
      .catch(() => {
        // Soft-fail — the card hides the weather section if storms
        // never resolves, the parcel section still renders.
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setStormsLoading(false);
      });
    return () => ctrl.abort();
  }, [result.tile.centerLat, result.tile.centerLng]);

  // Voice-consent / "rep at my door" state. The customer must explicitly
  // tick the consent box before the call dispatch fires.
  const [voiceConsent, setVoiceConsent] = useState(false);
  const [bookingState, setBookingState] = useState<"idle" | "sending" | "booked" | "error">("idle");
  const [bookingError, setBookingError] = useState<string | null>(null);

  async function bookInPersonEstimate(): Promise<void> {
    if (!voiceConsent || !leadPublicId) return;
    setBookingState("sending");
    setBookingError(null);
    try {
      const res = await fetch(
        `/api/leads/${encodeURIComponent(leadPublicId)}/voice-consent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Server controls the disclosure text — sending it from the
          // client would have been forgeable in the TCPA audit row.
          body: JSON.stringify({ consent: true }),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Booking service ${res.status}: ${text.slice(0, 200)}`);
      }
      setBookingState("booked");
    } catch (err) {
      setBookingError(err instanceof Error ? err.message : String(err));
      setBookingState("error");
    }
  }

  return (
    <div className="relative min-h-[100dvh] flex flex-col">
      <div className="ambient" />
      <PinHeader />

      <div className="relative z-10 max-w-5xl mx-auto px-6 lg:px-10 pt-10 lg:pt-14 pb-16 w-full">
        <div className="text-center">
          <div className="eyebrow mb-3">Your roof, measured</div>
          <h2
            className="font-serif tracking-tight"
            style={{
              fontSize: "clamp(36px, 5vw, 56px)",
              lineHeight: 1.04,
              fontWeight: 500,
              color: "var(--vx-ink)",
            }}
          >
            {sqft != null ? (
              <>
                <span className="tabular">{sqft.toLocaleString()}</span>{" "}
                <span className="italic font-light" style={{ color: "var(--vx-ink-soft)" }}>
                  square feet
                </span>
              </>
            ) : (
              <span className="italic font-light" style={{ color: "var(--vx-ink-soft)" }}>
                Measurement in review
              </span>
            )}
          </h2>
          <p
            className="font-serif italic mx-auto mt-3"
            style={{ fontSize: "15px", color: "var(--vx-ink-soft)" }}
          >
            {resolved.formatted}
          </p>
          {/* Imagery-quality badge. Solar API publishes how good the
              satellite imagery is for this property — HIGH means we
              measured against the freshest photogrammetric pass and
              the customer can trust the number cold; MEDIUM/LOW means
              the photo is older or partial and a rep should review on
              site before we hand over a binding quote. Surfacing this
              up-front sets expectations honestly instead of letting a
              LOW-imagery result get treated like a HIGH-imagery one. */}
          {result.solar.imageryQuality && (
            <ImageryQualityBadge
              quality={result.solar.imageryQuality}
              date={result.solar.imageryDate}
            />
          )}
        </div>

        {/* Above-the-fold row — image LEFT, price + CTA RIGHT on lg+.
            `items-center` keeps the two columns vertically balanced so
            the painted image doesn't tower over the price card. The
            grid auto-rows-fr makes them visually paired blocks. */}
        <div className="mt-10 grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-8 lg:gap-10 items-center justify-items-center w-full">
          {/* Painted image */}
          {paintedImageBase64 ? (
            <div
              className="result-card overflow-hidden mx-auto w-full"
              style={{ maxWidth: "480px", aspectRatio: "1 / 1" }}
            >
              <span className="marker absolute -top-[3px] -left-[3px]" aria-hidden="true" />
              <span className="marker absolute -top-[3px] -right-[3px]" aria-hidden="true" />
              <span className="marker absolute -bottom-[3px] -left-[3px]" aria-hidden="true" />
              <span className="marker absolute -bottom-[3px] -right-[3px]" aria-hidden="true" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`data:image/png;base64,${paintedImageBase64}`}
                alt="Your roof, outlined"
                className="w-full h-full object-cover"
              />
            </div>
          ) : (
            <div />
          )}

          {/* Right column: price + voice-consent CTA, stacked. */}
          <div className="flex flex-col gap-5 w-full" style={{ maxWidth: "440px" }}>
            {tiers && (
              <div className="result-card" style={{ padding: "22px 20px" }}>
                <div className="eyebrow mb-3 text-center">Three ways to roof this home</div>
                <div className="flex flex-col" style={{ gap: "10px" }}>
                  {tiers.map((t) => (
                    <TierRow key={t.tier.id} tier={t} />
                  ))}
                </div>
                <div
                  className="mt-4 pt-4 mx-auto text-center"
                  style={{
                    fontSize: "12px",
                    lineHeight: 1.55,
                    color: "var(--vx-ink-soft)",
                    maxWidth: "40ch",
                    borderTop: "1px solid var(--vx-rule)",
                  }}
                >
                  <span style={{ color: "var(--vx-ink)", fontWeight: 700 }}>
                    Not a final or binding quote.
                  </span>{" "}
                  Quick visual estimate from satellite imagery. Final price
                  depends on what we find on site (decking condition,
                  layers, code work). Confirmed by a licensed roofer.
                </div>
                {/* Display-vs-quotable clarification — only renders when the
                    headline sqft (3°+ filter, the homeowner's "whole roof")
                    differs from the asphalt-shingle pricing area (12°+
                    filter). Quietly explains why the tier prices map to a
                    smaller number, instead of leaving the customer to wonder
                    if our math is broken. */}
                {result.solar.quotableSqft != null &&
                  sqft != null &&
                  result.solar.quotableSqft < sqft && (
                    <div
                      className="mt-2 mx-auto text-center font-serif italic"
                      style={{
                        fontSize: "11px",
                        lineHeight: 1.5,
                        color: "var(--vx-muted)",
                        maxWidth: "44ch",
                      }}
                    >
                      Tier prices cover the{" "}
                      <span className="tabular" style={{ fontStyle: "normal" }}>
                        {result.solar.quotableSqft.toLocaleString()}
                      </span>{" "}
                      sqft of asphalt-shingle roof. The remaining{" "}
                      <span className="tabular" style={{ fontStyle: "normal" }}>
                        {(sqft - result.solar.quotableSqft).toLocaleString()}
                      </span>{" "}
                      sqft is low-slope and quotes separately on site (different
                      material, different price).
                    </div>
                  )}
                <div
                  className="mt-2 text-center"
                  style={{
                    fontSize: "11px",
                    color: "var(--vx-ink-soft)",
                    opacity: 0.7,
                  }}
                >
                  Priced as {pricingMaterial.label.toLowerCase()} · {result.pricing?.recommendedWastePercent ?? 12}% waste assumed
                </div>
                <div
                  className="mt-1 text-center"
                  style={{
                    fontSize: "10.5px",
                    color: "var(--vx-muted)",
                    letterSpacing: "0.04em",
                    fontFamily: "var(--vx-font-ui)",
                  }}
                >
                  Monthly est. assumes 15-year financing at 9.99% APR.
                  Actual terms depend on credit + your finance partner.
                </div>
              </div>
            )}

            {/* Voice consent CTA — sits right next to the price. */}
            {bookingState === "booked" ? (
              <div
                className="result-card text-center"
                style={{
                  padding: "22px 20px",
                  borderColor: "var(--vx-terra)",
                }}
              >
                <div className="eyebrow mb-2" style={{ color: "var(--vx-terra)" }}>
                  You&apos;re on the list
                </div>
                <p
                  className="font-serif mx-auto"
                  style={{
                    fontSize: "18px",
                    lineHeight: 1.35,
                    color: "var(--vx-ink)",
                  }}
                >
                  A specialist will call within a few minutes to confirm a time. Watch your phone.
                </p>
              </div>
            ) : (
              <div className="result-card" style={{ padding: "20px 20px" }}>
                <div className="eyebrow mb-3">Want a rep at your door?</div>
                <label
                  className="flex items-start gap-3 cursor-pointer"
                  style={{
                    fontSize: "13px",
                    color: "var(--vx-ink-soft)",
                    lineHeight: 1.55,
                  }}
                >
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={voiceConsent}
                    onChange={(e) => setVoiceConsent(e.target.checked)}
                    disabled={!leadPublicId || bookingState === "sending"}
                  />
                  <span>
                    <span style={{ color: "var(--vx-ink)", fontWeight: 600 }}>
                      Call me with an automated voice intro
                    </span>{" "}
                    to walk through this estimate and book an on-site visit. I can hang up or reply STOP anytime.
                  </span>
                </label>
                <div className="mt-4">
                  <button
                    type="button"
                    className="btn-terra w-full"
                    disabled={
                      !voiceConsent ||
                      !leadPublicId ||
                      bookingState === "sending"
                    }
                    onClick={bookInPersonEstimate}
                  >
                    {bookingState === "sending" ? "Booking…" : "Get a rep to my door"}
                    <span className="arrow" aria-hidden="true">→</span>
                  </button>
                </div>
                {!leadPublicId && (
                  <p
                    className="mt-3"
                    style={{
                      fontSize: "11px",
                      color: "var(--vx-muted)",
                      fontStyle: "italic",
                    }}
                  >
                    Refresh and resubmit to enable booking.
                  </p>
                )}
                {bookingState === "error" && bookingError && (
                  <p className="mt-3" style={{ fontSize: "11px", color: "#8a2c2c" }}>
                    {bookingError}
                  </p>
                )}
              </div>
            )}

            {/* Tertiary: re-pin link, ghost. */}
            <div className="text-center">
              <button
                type="button"
                onClick={onRePin}
                style={{
                  fontSize: "11px",
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  color: "var(--vx-muted)",
                  fontWeight: 600,
                  background: "none",
                  border: 0,
                  cursor: "pointer",
                  padding: "4px 0",
                }}
              >
                ← Re-pin building center
              </button>
            </div>
          </div>
        </div>

        {/* Measurement chips. FACES E ("predominant compass") removed —
            not useful to the customer. */}
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          {pitch != null && (
            <span className="chip">
              Pitch <span className="chip-value">{pitchOn12 ?? `${Math.round(pitch)}°`}</span>
            </span>
          )}
          {(() => {
            // Display the higher of (Solar's resolved-segment count, Gemini's
            // visual count). Solar under-segments on MEDIUM imagery — Gemini
            // sees the painted polygons accurately. The math layer keeps
            // using Solar's per-facet array because that's the only source
            // with pitch + azimuth + area per plane; we just don't surface
            // the undercount to the customer.
            const geminiCount = result.geminiAnalysis.facetCountEstimate?.count ?? 0;
            const display = Math.max(facets.length, geminiCount);
            if (display <= 0) return null;
            return (
              <span className="chip">
                Facets <span className="chip-value">{display}</span>
              </span>
            );
          })()}
          {/* Stories chip removed 2026-05-18 — single-angle satellite
              can't reliably tell single-story from multi-story (no
              parallax, no shadow cast off vertical walls in the
              tile). EagleView gets it from oblique imagery; we don't
              have that signal. Rather than show a wrong number, we
              omit it. `derived.stories` is still computed server-
              side for the rep workbench and rep PDF flow. */}
          <span className="chip">
            Complexity <span className="chip-value">{derived.complexity}</span>
          </span>
        </div>

        {/* Penetrations / objects */}
        {Object.keys(objectCounts).length > 0 && (
          <div className="mt-6">
            <div className="text-center eyebrow mb-4">On the roof</div>
            <div className="flex flex-wrap justify-center gap-3">
              {Object.entries(objectCounts).map(([type, count]) => (
                <span key={type} className="chip">
                  {humanizeObjectType(type, count)}{" "}
                  <span className="chip-value tabular">×{count}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* "Why this roof needs attention" — parcel age + recent storms.
            The two strongest signals an honest roofer can show a homeowner
            before quoting: how old the structure actually is (FL DOR
            statewide cadastral, free) and what the property has been
            through recently (NWS Local Storm Reports via the Iowa State
            Mesonet, ~T+1h fresh, free). Card hides itself entirely when
            neither data source resolved — no "no data" placeholders. */}
        <WhyNowCard parcel={parcel} storms={storms} stormsLoading={stormsLoading} />

        {/* Detail line under the price (full-width below the fold so it
            doesn't crowd the above-the-fold price card). */}
        {tiers && (
          <div
            className="mt-10 mx-auto font-serif italic text-center"
            style={{
              fontSize: "14px",
              color: "var(--vx-ink-soft)",
              maxWidth: "56ch",
            }}
          >
            Every tier includes tear-off, underlayment, ridge cap, drip edge,
            flashing, labor, and haul-away. Final number depends on deck
            condition, code-driven upgrades, and your exact material
            selection — confirmed on site by a licensed roofer.
          </div>
        )}

        <div className="mt-10 text-center">
          <button
            type="button"
            onClick={onStartOver}
            style={{
              fontSize: "11px",
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "var(--vx-muted)",
              fontWeight: 600,
              background: "none",
              border: 0,
              cursor: "pointer",
              padding: "8px 0",
            }}
          >
            Start a new estimate
          </button>
        </div>
      </div>

      <VoxarisFooter />
    </div>
  );
}

// ─── Imagery quality badge ─────────────────────────────────────────────
//
// Tiny inline pill that sits under the address line and tells the
// homeowner how confident they should be in the headline number.
// Solar API's `imageryQuality` (HIGH / MEDIUM / LOW / BASE) is a
// straightforward proxy: HIGH means we measured against a recent,
// clean photogrammetric pass; MEDIUM/LOW means the imagery is older,
// partial, or low-resolution and a rep should ground-truth on site.
//
// Why expose this: a customer comparing two estimates (ours vs a
// competitor) can't tell that one was based on a six-month-old aerial
// of the previous owner's tear-down. We can tell them.

function ImageryQualityBadge({
  quality,
  date,
}: {
  quality: string;
  date: string | null;
}) {
  const upper = quality.toUpperCase();
  const isHigh = upper === "HIGH";
  const isLimited = upper === "LOW" || upper === "BASE";

  // Pretty date — `imageryDate` ships as "YYYY-MM-DD". Render as
  // "Mar 2024" so the homeowner immediately reads "imagery age."
  const prettyDate = date
    ? new Date(date + "T00:00:00Z").toLocaleDateString(undefined, {
        month: "short",
        year: "numeric",
      })
    : null;

  const label = isHigh
    ? "High-resolution satellite imagery"
    : isLimited
      ? "Limited imagery — rep will review on site"
      : "Standard satellite imagery";

  return (
    <div className="mt-3 flex justify-center" aria-label={label}>
      <span
        className="font-serif italic"
        style={{
          fontSize: "11px",
          letterSpacing: "0.04em",
          color: isLimited ? "var(--vx-terra)" : "var(--vx-ink-soft)",
          padding: "3px 10px",
          border: `1px solid ${isLimited ? "var(--vx-terra)" : "var(--vx-rule)"}`,
          borderRadius: "999px",
          background: "transparent",
        }}
      >
        {label}
        {prettyDate && (
          <span
            style={{
              marginLeft: 6,
              color: "var(--vx-muted)",
              fontStyle: "normal",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            · {prettyDate}
          </span>
        )}
      </span>
    </div>
  );
}

// ─── "Why this roof needs attention" card ──────────────────────────────
//
// Renders two evidence-based reasons the homeowner should be thinking
// about their roof right now:
//
//   1. PROPERTY FACTS — pulled from the FL statewide cadastral
//      (ACT_YR_BLT, EFF_YR_BLT, last recorded sale). Aerial imagery
//      cannot answer "how old is this thing?" — the cadastral can,
//      from official county tax-roll data, for free.
//
//   2. RECENT SEVERE WEATHER — pulled from the NWS Local Storm Reports
//      mirrored by Iowa State Mesonet, last 12 months, 25mi radius.
//      "Wind gusts to 61mph at the Port of Palm Beach in April" hits
//      different than a generic "storm damage matters" disclaimer.
//
// Layout: card with two sections side-by-side on desktop, stacked on
// mobile. Each section gracefully hides if its data didn't resolve.
// Card hides entirely when both are null — no "no data" UI noise.
//
// The italic serif footer below the rows is the narrative payoff —
// reads like a paragraph, not a stat sheet. That's where this whole
// card earns its keep.

function WhyNowCard({
  parcel,
  storms,
  stormsLoading,
}: {
  parcel: V3Response["parcel"];
  storms: RecentStormsResponse | null;
  /** True while /api/storms/recent is in flight. We render the parcel
   *  column immediately and show a skeleton in the storms column so
   *  the card doesn't pop in late and cause a layout jump as the
   *  customer is reading the rest of the page. */
  stormsLoading: boolean;
}) {
  // Bail out if neither data source resolved AND we're not still waiting
  // on storms. Keeps the page calm when we're estimating for an
  // out-of-state property, brand-new build, or genuinely nothing
  // happened in the last 12 months around the address.
  const hasParcel = parcel != null && parcel.yearBuilt != null;
  const hasStorms = storms != null && storms.summary.total > 0;
  if (!hasParcel && !hasStorms && !stormsLoading) return null;

  const currentYear = new Date().getFullYear();
  const age = hasParcel ? currentYear - (parcel.yearBuilt as number) : null;
  const effAge =
    hasParcel && parcel.effectiveYearBuilt && parcel.effectiveYearBuilt > 0
      ? currentYear - parcel.effectiveYearBuilt
      : null;
  const yearsOwned =
    hasParcel && parcel.lastSale ? currentYear - parcel.lastSale.year : null;

  // Recent-storm narrative pieces. We summarize at a level the customer
  // actually recognizes ("3 wind events past year", "hail to 1.5"") and
  // pull at most 3 most-significant events for the bullet list.
  const sortedEvents = (storms?.events ?? [])
    .slice()
    .sort((a, b) => (b.magnitude ?? 0) - (a.magnitude ?? 0))
    .slice(0, 3);

  // The italic-serif closer. Builds dynamically off whatever data we
  // have so the card never looks like a fill-in-the-blank template.
  const closer = buildWhyNowNarrative({
    age,
    effAge,
    yearsOwned,
    storms: storms?.summary ?? null,
  });

  return (
    <div className="mt-12 mx-auto" style={{ maxWidth: "920px" }}>
      <div className="text-center eyebrow mb-4">Why this roof needs attention</div>
      <div
        className="result-card relative"
        style={{ padding: "26px 24px" }}
      >
        {/* Brand corner markers, same as the painted-image frame */}
        <span className="marker absolute -top-[3px] -left-[3px]" aria-hidden="true" />
        <span className="marker absolute -top-[3px] -right-[3px]" aria-hidden="true" />
        <span className="marker absolute -bottom-[3px] -left-[3px]" aria-hidden="true" />
        <span className="marker absolute -bottom-[3px] -right-[3px]" aria-hidden="true" />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
          {/* ── Property facts ── */}
          {hasParcel ? (
            <section>
              <div
                className="font-serif italic mb-3"
                style={{ fontSize: "13px", color: "var(--vx-terra)" }}
              >
                Property record
              </div>
              <dl className="space-y-2">
                {age != null && (
                  <WhyRow
                    label="Year built"
                    value={
                      <>
                        <span className="tabular">{parcel!.yearBuilt}</span>
                        <span
                          className="font-serif italic ml-2"
                          style={{ color: "var(--vx-ink-soft)" }}
                        >
                          {age} yr old
                        </span>
                      </>
                    }
                  />
                )}
                {effAge != null && effAge !== age && (
                  <WhyRow
                    label="Last renovated"
                    value={
                      <>
                        <span className="tabular">{parcel!.effectiveYearBuilt}</span>
                        <span
                          className="font-serif italic ml-2"
                          style={{ color: "var(--vx-ink-soft)" }}
                        >
                          {effAge} yr ago
                        </span>
                      </>
                    }
                  />
                )}
                {parcel?.livingSqft != null && (
                  <WhyRow
                    label="Living area"
                    value={
                      <span className="tabular">
                        {parcel.livingSqft.toLocaleString()} sqft
                      </span>
                    }
                  />
                )}
                {parcel?.lastSale && yearsOwned != null && (
                  <WhyRow
                    label="Last sale"
                    value={
                      <>
                        <span className="tabular">
                          ${(parcel.lastSale.priceUsd / 1000).toFixed(0)}k
                        </span>
                        <span
                          className="font-serif italic ml-2"
                          style={{ color: "var(--vx-ink-soft)" }}
                        >
                          {parcel.lastSale.year} · {yearsOwned} yr owned
                        </span>
                      </>
                    }
                  />
                )}
              </dl>
              <div
                className="mt-3 font-serif italic"
                style={{ fontSize: "11px", color: "var(--vx-muted)" }}
              >
                Source: Florida Dept. of Revenue cadastral
                {parcel?.assessmentYear ? `, ${parcel.assessmentYear} roll` : ""}.
              </div>
            </section>
          ) : (
            <section aria-hidden />
          )}

          {/* ── Recent severe weather ── */}
          {stormsLoading && !hasStorms ? (
            // Skeleton while /api/storms/recent is in flight. Reserves
            // the column's vertical space so the rest of the card
            // doesn't jump when storms data arrives ~500-1500ms after
            // the V3 result lands.
            <section aria-busy="true" aria-label="Loading recent severe weather">
              <div
                className="font-serif italic mb-3"
                style={{ fontSize: "13px", color: "var(--vx-terra)" }}
              >
                Severe weather, last 12 months
              </div>
              <div className="space-y-2.5">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    style={{
                      height: 14,
                      background:
                        "linear-gradient(90deg, var(--vx-rule) 0%, var(--vx-rule) 40%, transparent 100%)",
                      borderRadius: 3,
                      opacity: 0.55,
                      width: i === 2 ? "70%" : "100%",
                    }}
                  />
                ))}
                <div
                  className="mt-3 font-serif italic"
                  style={{ fontSize: "11px", color: "var(--vx-muted)" }}
                >
                  Reading the National Weather Service log…
                </div>
              </div>
            </section>
          ) : hasStorms ? (
            <section>
              <div
                className="font-serif italic mb-3"
                style={{ fontSize: "13px", color: "var(--vx-terra)" }}
              >
                Severe weather, last 12 months
              </div>
              <dl className="space-y-2">
                <WhyRow
                  label="Events within 25 mi"
                  value={
                    <span className="tabular">{storms!.summary.total}</span>
                  }
                />
                {storms!.summary.hailCount > 0 && (
                  <WhyRow
                    label="Hail reports"
                    value={
                      <>
                        <span className="tabular">{storms!.summary.hailCount}</span>
                        {storms!.summary.maxHailInches != null && (
                          <span
                            className="font-serif italic ml-2"
                            style={{ color: "var(--vx-ink-soft)" }}
                          >
                            up to {storms!.summary.maxHailInches.toFixed(2)}″
                          </span>
                        )}
                      </>
                    }
                  />
                )}
                {storms!.summary.windCount > 0 && (
                  <WhyRow
                    label="Damaging-wind reports"
                    value={
                      <span className="tabular">{storms!.summary.windCount}</span>
                    }
                  />
                )}
                {storms!.summary.tornadoCount > 0 && (
                  <WhyRow
                    label="Tornado / funnel reports"
                    value={
                      <span className="tabular">
                        {storms!.summary.tornadoCount}
                      </span>
                    }
                  />
                )}
              </dl>

              {sortedEvents.length > 0 && (
                <ul
                  className="mt-3 space-y-1"
                  style={{
                    fontSize: "12px",
                    color: "var(--vx-ink-soft)",
                  }}
                >
                  {sortedEvents.map((e, i) => (
                    <li key={i} className="flex justify-between gap-3">
                      <span style={{ textTransform: "capitalize" }}>
                        {e.type}
                        {e.magnitude != null && e.type === "hail" && (
                          <span className="ml-1 tabular">
                            {e.magnitude.toFixed(2)}″
                          </span>
                        )}
                        {e.magnitude != null && e.type !== "hail" && (
                          <span className="ml-1 tabular">
                            {Math.round(e.magnitude)} mph
                          </span>
                        )}
                      </span>
                      <span
                        className="font-serif italic"
                        style={{ color: "var(--vx-muted)", whiteSpace: "nowrap" }}
                      >
                        {e.distanceMiles != null
                          ? `${e.distanceMiles.toFixed(1)} mi`
                          : "—"}{" "}
                        ·{" "}
                        {e.date
                          ? new Date(e.date).toLocaleDateString(undefined, {
                              month: "short",
                              year: "numeric",
                            })
                          : "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div
                className="mt-3 font-serif italic"
                style={{ fontSize: "11px", color: "var(--vx-muted)" }}
              >
                Source: NWS Local Storm Reports via Iowa Environmental Mesonet.
              </div>
            </section>
          ) : (
            <section aria-hidden />
          )}
        </div>

        {/* Narrative closer — italic serif, full width under both columns.
            Reads like a sentence, not a bullet point. */}
        {closer && (
          <div
            className="mt-6 pt-5 mx-auto font-serif italic text-center"
            style={{
              fontSize: "15px",
              lineHeight: 1.55,
              color: "var(--vx-ink)",
              maxWidth: "56ch",
              borderTop: "1px solid var(--vx-rule)",
            }}
          >
            {closer}
          </div>
        )}
      </div>
    </div>
  );
}

function WhyRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex justify-between items-baseline gap-4">
      <dt
        style={{
          fontSize: "11px",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--vx-muted)",
          fontWeight: 600,
        }}
      >
        {label}
      </dt>
      <dd
        style={{
          fontSize: "15px",
          color: "var(--vx-ink)",
          fontWeight: 600,
          textAlign: "right",
        }}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * Build the italic-serif closing sentence. Dynamic so the line never
 * reads like template-fill: prioritizes the strongest signal we have.
 *
 * Priority order:
 *   1. Recent hail with measurable size  — most actionable, most credible
 *   2. Damaging-wind events at the right magnitude
 *   3. Old roof structure (age >= 18 yr, the asphalt-shingle retirement mark)
 *   4. Long ownership tenure + age combo
 *   5. Generic age-only fallback
 *
 * Returns null when we genuinely have nothing meaningful to say — better
 * to hide the closer entirely than ship a hollow "based on the data above"
 * filler line.
 */
function buildWhyNowNarrative({
  age,
  effAge,
  yearsOwned,
  storms,
}: {
  age: number | null;
  effAge: number | null;
  yearsOwned: number | null;
  storms: RecentStormsResponse["summary"] | null;
}): string | null {
  // 1. Recent hail — the highest-leverage talking point.
  if (storms && storms.hailCount > 0 && storms.maxHailInches != null) {
    const hailSize = storms.maxHailInches;
    if (hailSize >= 1.0) {
      return `Hail up to ${hailSize.toFixed(2)} inches was reported within 25 miles in the last year. Hail at that size impacts asphalt-shingle granule loss and shortens the roof's remaining life — even when damage isn't visible from the ground.`;
    }
    return `${storms.hailCount} hail event${storms.hailCount > 1 ? "s" : ""} reported within 25 miles in the last 12 months. Recurrent hail accelerates granule loss and shortens shingle life, regardless of any single event being a total-loss claim.`;
  }

  // 2. Damaging wind at a magnitude that matters (≥ 45 mph gust).
  if (storms && storms.windCount >= 3) {
    return `${storms.windCount} damaging-wind events were logged within 25 miles in the past year. Repeated high-wind exposure stresses fasteners and seal strips — small failures now become leaks at the next big storm.`;
  }

  // 3. Old roof structure — the asphalt-shingle retirement signal.
  const effectiveAge = effAge ?? age;
  if (effectiveAge != null && effectiveAge >= 18) {
    if (yearsOwned != null && yearsOwned >= 10) {
      return `You've owned this home ${yearsOwned} years and the roof structure is ${effectiveAge}. Asphalt shingles typically retire between 18 and 25 — your roof is in that window now, and most homeowners replace once before they sell.`;
    }
    return `This roof structure is ${effectiveAge} years old. Asphalt shingles typically retire between 18 and 25 years — your roof is in that replacement window now.`;
  }

  // 4. Moderate-age roof + storm activity, even when neither alone is strong.
  if (storms && storms.total >= 3 && age != null && age >= 10) {
    return `This roof is ${age} years old, and ${storms.total} severe-weather events have been logged within 25 miles in the last year. Both signals compound — older roofs lose more granules per storm than new ones.`;
  }

  // 5. Generic age-only — light closer.
  if (age != null && age >= 10) {
    return `This roof is ${age} years old. Most Florida asphalt roofs see a measurable performance drop in their second decade — UV, salt air, and afternoon thunderstorms all contribute.`;
  }

  return null;
}

// ─── Error screen ───────────────────────────────────────────────────────

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="relative min-h-[100dvh] flex flex-col">
      <div className="ambient" />
      <PinHeader />
      <div className="relative z-10 max-w-xl mx-auto px-6 lg:px-10 pt-24 lg:pt-32 pb-10 w-full text-center">
        <div className="eyebrow mb-3">Something didn&apos;t resolve</div>
        <h2
          className="font-serif tracking-tight"
          style={{
            fontSize: "clamp(32px, 4.5vw, 48px)",
            lineHeight: 1.04,
            fontWeight: 500,
            color: "var(--vx-ink)",
          }}
        >
          We couldn&apos;t measure that roof.
        </h2>
        <p className="mt-5" style={{ fontSize: "15px", color: "var(--vx-ink-soft)", fontWeight: 300 }}>
          {message}
        </p>
        <div className="mt-10">
          <button type="button" className="btn-terra" onClick={onRetry}>
            Try a different address
            <span className="arrow" aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Shared wordmark ────────────────────────────────────────────────────

/** Brand wordmark. Uses the alpha-transparent VOXARIS AI wordmark
 *  (logo-wordmark-alpha.png) which renders correctly on any background
 *  without a CSS filter. Falls back to the DragonEF text wordmark if
 *  the image file is missing. */
// ─── Good / Better / Best tier row ──────────────────────────────────────

function TierRow({ tier }: { tier: TierPrice }) {
  const [open, setOpen] = useState(tier.tier.id === "better");
  const accentColor =
    tier.tier.accent === "premium"
      ? "var(--vx-terra-dark)"
      : tier.tier.accent === "primary"
        ? "var(--vx-terra)"
        : "var(--vx-ink-soft)";
  return (
    <div
      style={{
        border: `1px solid ${tier.tier.accent === "primary" ? "var(--vx-terra)" : "var(--vx-rule)"}`,
        borderRadius: "10px",
        padding: "12px 14px",
        background: tier.tier.accent === "primary" ? "rgba(199, 107, 63, 0.06)" : "transparent",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          width: "100%",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "12px",
          background: "none",
          border: 0,
          padding: 0,
          cursor: "pointer",
          textAlign: "left",
        }}
        aria-expanded={open}
      >
        <span style={{ flex: 1 }}>
          <span
            className="eyebrow"
            style={{ color: accentColor, fontWeight: 700, marginRight: "8px" }}
          >
            {tier.tier.name}
          </span>
          <span
            style={{
              fontSize: "12px",
              color: "var(--vx-ink-soft)",
              fontStyle: "italic",
            }}
          >
            {tier.tier.tagline}
          </span>
        </span>
        <span
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "2px",
            whiteSpace: "nowrap",
          }}
        >
          <span
            className="font-serif tabular"
            style={{
              fontSize: "22px",
              fontWeight: 500,
              color: "var(--vx-ink)",
              letterSpacing: "-0.01em",
              lineHeight: 1,
            }}
          >
            ${tier.monthly.toLocaleString()}
            <span
              style={{
                fontFamily: "var(--vx-font-ui)",
                fontSize: "11px",
                fontWeight: 600,
                letterSpacing: "0.04em",
                color: "var(--vx-muted)",
                marginLeft: "4px",
              }}
            >
              /mo
            </span>
          </span>
          <span
            className="tabular"
            style={{
              fontSize: "10.5px",
              letterSpacing: "0.04em",
              color: "var(--vx-muted)",
              fontFamily: "var(--vx-font-ui)",
            }}
          >
            est. ${tier.total.toLocaleString()} total
          </span>
        </span>
      </button>
      {open && (
        <div
          style={{
            marginTop: "10px",
            paddingTop: "10px",
            borderTop: "1px dashed var(--vx-rule)",
            fontSize: "12px",
            color: "var(--vx-ink-soft)",
            lineHeight: 1.55,
          }}
        >
          <ul style={{ paddingLeft: "16px", margin: 0 }}>
            {tier.tier.features.map((f, i) => (
              <li key={i} style={{ marginBottom: "3px" }}>{f}</li>
            ))}
          </ul>
          <div
            style={{
              marginTop: "8px",
              fontSize: "10.5px",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: accentColor,
              fontWeight: 700,
            }}
          >
            {tier.tier.warranty}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Text-only wordmark — proxies to the shared `<Wordmark>` component.
 *
 * Was previously an `<img>`-first lockup with a DragonEF text fallback.
 * Brand owner (2026-05) directed the text version everywhere, in the
 * navy `--vx-ink`, so this local function now just maps the existing
 * `size` API onto the shared component and forwards `tone`.
 *
 * Customer-page sizes:
 *   lg — hero on `/`           (~80px cap height, matches the new shared lg)
 *   md — page header           (~32px)
 *   sm — footer / chips        (~22px)
 */
function Wordmark({
  size = "lg",
  tone = "ink",
}: {
  size?: "lg" | "md" | "sm";
  tone?: "ink" | "cream";
}) {
  return <SharedWordmark size={size} tone={tone} />;
}

// ─── Shared chrome ──────────────────────────────────────────────────────

function PinHeader({ onBack }: { onBack?: () => void } = {}) {
  return (
    <header className="relative z-20 pt-7 lg:pt-10">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 flex items-center justify-between">
        <Link href="/" className="leading-none" aria-label="Voxaris — home">
          <Wordmark size="md" tone="ink" />
        </Link>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            style={{
              fontSize: "11px",
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "var(--vx-ink-soft)",
              fontWeight: 600,
              background: "none",
              border: 0,
              cursor: "pointer",
            }}
          >
            Start over
          </button>
        )}
      </div>
    </header>
  );
}

function VoxarisFooter() {
  // Dark-variant footer per brand §04 Primary · Dark lockup. Wordmark is
  // "Voxaris." with the period (non-negotiable on hero placements).
  return (
    <footer className="relative z-10" style={{ background: "var(--vx-ink)", color: "var(--vx-paper)" }}>
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-16 lg:py-20">
        <div className="grid lg:grid-cols-12 gap-12 items-start">
          <div className="lg:col-span-6">
            <div className="mb-4">
              <Wordmark size="lg" tone="cream" />
            </div>
            <div
              className="eyebrow mb-6"
              style={{ color: "rgba(236, 227, 208, 0.55)" }}
            >
              Premium roof intelligence
            </div>
            <p
              className="font-serif italic"
              style={{
                color: "rgba(236, 227, 208, 0.78)",
                fontSize: "17px",
                lineHeight: 1.6,
                maxWidth: "28rem",
                fontWeight: 400,
              }}
            >
              A real roof estimate, measured from above. Free, in thirty seconds.
            </p>
          </div>
          <div className="lg:col-span-3">
            <div className="eyebrow mb-5" style={{ color: "rgba(236, 227, 208, 0.55)" }}>
              Correspondence
            </div>
            <ul
              className="space-y-2.5"
              style={{ fontSize: "13px", color: "rgba(236, 227, 208, 0.78)", fontWeight: 600 }}
            >
              <li>
                <a href="mailto:admin@voxaris.io">admin@voxaris.io</a>
              </li>
              <li className="tabular">
                <a href="tel:+14078195809">(407) 819 · 5809</a>
              </li>
            </ul>
          </div>
          <div className="lg:col-span-3">
            <div className="eyebrow mb-5" style={{ color: "rgba(236, 227, 208, 0.55)" }}>
              Particulars
            </div>
            <ul
              className="space-y-2.5"
              style={{ fontSize: "13px", color: "rgba(236, 227, 208, 0.78)", fontWeight: 600 }}
            >
              <li>
                <Link href="/privacy">Privacy</Link>
                <span style={{ margin: "0 6px", color: "rgba(236, 227, 208, 0.32)" }}>·</span>
                <Link href="/terms">Terms</Link>
              </li>
            </ul>
          </div>
        </div>
        <hr style={{ borderTop: "1px solid rgba(236, 227, 208, 0.08)", margin: "56px 0 24px" }} />
        <div
          className="flex flex-wrap justify-between items-center gap-4"
          style={{
            fontSize: "10.5px",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "rgba(236, 227, 208, 0.42)",
            fontWeight: 600,
          }}
        >
          <span>© 2026 Voxaris, Inc.</span>
          <span>Orlando · Florida</span>
        </div>
      </div>
    </footer>
  );
}

// ─── SVG ornaments (verbatim from mock) ────────────────────────────────

function CrescentSvg() {
  return (
    <svg
      className="crescent"
      viewBox="0 0 1600 800"
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio="xMidYMin meet"
    >
      <defs>
        <linearGradient id="crescOuter" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8A7E68" stopOpacity="0" />
          <stop offset="50%" stopColor="#8A7E68" stopOpacity=".95" />
          <stop offset="100%" stopColor="#8A7E68" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="crescMid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8A7E68" stopOpacity="0" />
          <stop offset="55%" stopColor="#8A7E68" stopOpacity=".75" />
          <stop offset="100%" stopColor="#8A7E68" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="crescInner" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8A7E68" stopOpacity="0" />
          <stop offset="60%" stopColor="#8A7E68" stopOpacity=".55" />
          <stop offset="100%" stopColor="#8A7E68" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="crescGlow" cx="50%" cy="40%" r="50%">
          <stop offset="0%" stopColor="#8A7E68" stopOpacity=".18" />
          <stop offset="70%" stopColor="#8A7E68" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="800" cy="380" rx="720" ry="320" fill="url(#crescGlow)" />
      <path d="M 40 440 A 780 780 0 0 1 1560 440" fill="none" stroke="url(#crescOuter)" strokeWidth="2" />
      <path d="M 130 480 A 700 700 0 0 1 1470 480" fill="none" stroke="url(#crescMid)" strokeWidth="1.3" />
      <path d="M 240 530 A 600 600 0 0 1 1360 530" fill="none" stroke="url(#crescInner)" strokeWidth="0.9" />
      <path d="M 360 600 A 500 500 0 0 1 1240 600" fill="none" stroke="#8A7E68" strokeWidth="0.7" strokeOpacity=".38" />
      <path d="M 480 680 A 400 400 0 0 1 1120 680" fill="none" stroke="#8A7E68" strokeWidth="0.6" strokeOpacity=".22" />
      <g stroke="#8A7E68" strokeOpacity=".75">
        <line x1="800" y1="60" x2="800" y2="92" strokeWidth="1.5" />
        <line x1="670" y1="78" x2="676" y2="106" strokeWidth="1" />
        <line x1="930" y1="78" x2="924" y2="106" strokeWidth="1" />
        <line x1="540" y1="115" x2="552" y2="142" strokeWidth="1" />
        <line x1="1060" y1="115" x2="1048" y2="142" strokeWidth="1" />
        <line x1="410" y1="170" x2="428" y2="195" strokeWidth="1" />
        <line x1="1190" y1="170" x2="1172" y2="195" strokeWidth="1" />
        <line x1="290" y1="245" x2="312" y2="266" strokeWidth="1" />
        <line x1="1310" y1="245" x2="1288" y2="266" strokeWidth="1" />
        <line x1="180" y1="340" x2="206" y2="356" strokeWidth="1" />
        <line x1="1420" y1="340" x2="1394" y2="356" strokeWidth="1" />
      </g>
      <circle cx="800" cy="40" r="3" fill="#8A7E68" />
    </svg>
  );
}

function OrnamentSvg() {
  return (
    <svg className="ornament" viewBox="0 0 520 520" aria-hidden="true" focusable="false">
      <circle cx="260" cy="260" r="240" fill="none" stroke="#8A7E68" strokeWidth="1" />
      <circle cx="260" cy="260" r="180" fill="none" stroke="#8A7E68" strokeWidth="1" />
      <g stroke="#8A7E68" strokeWidth="1.5" fill="none">
        <path d="M260,80 L280,200 L260,220 L240,200 Z" />
        <path d="M260,440 L280,320 L260,300 L240,320 Z" />
        <path d="M80,260 L200,280 L220,260 L200,240 Z" />
        <path d="M440,260 L320,280 L300,260 L320,240 Z" />
      </g>
    </svg>
  );
}

function SkylineSvg() {
  return (
    <svg
      className="skyline"
      viewBox="0 0 1600 180"
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="rooftop-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0F1B2D" stopOpacity="0" />
          <stop offset="65%" stopColor="#0F1B2D" stopOpacity="0.10" />
          <stop offset="100%" stopColor="#0F1B2D" stopOpacity="0.22" />
        </linearGradient>
      </defs>
      <path
        d="M0 180 L0 130 L80 80 L160 130 L240 95 L320 130 L400 70 L480 130 L560 110 L640 130 L720 60 L800 130 L880 90 L960 130 L1040 50 L1120 130 L1200 100 L1280 130 L1360 75 L1440 130 L1520 95 L1600 130 L1600 180 Z"
        fill="url(#rooftop-fade)"
        stroke="rgba(15,27,45,0.22)"
        strokeWidth="1"
      />
    </svg>
  );
}
