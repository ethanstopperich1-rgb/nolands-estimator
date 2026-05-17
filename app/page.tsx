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
import Link from "next/link";
import { BotIdClient } from "botid/client";
import { loadGoogle } from "@/lib/google";
import {
  ARCHITECTURAL_SHINGLE_RATE_PER_SQFT,
  calculateCustomerPrice,
  calculateSuggestedWaste,
} from "@/lib/pricing/calculate-waste";

type Step = "hero" | "pin" | "loading" | "result" | "error";

interface AddressResolved {
  formatted: string;
  lat: number;
  lng: number;
}

interface V3Response {
  solar: {
    sqft: number | null;
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
  paintedImageBase64: string | null;
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
}

const LOADING_MESSAGES: Array<{ at: number; text: string }> = [
  { at: 0, text: "Fetching satellite imagery…" },
  { at: 3, text: "Measuring the roof…" },
  { at: 7, text: "Identifying the outline…" },
  { at: 13, text: "Tracing roof features…" },
  { at: 19, text: "Detecting vents and penetrations…" },
];

/** Editorial roofing facts rotated through the loading screen. Mix of
 *  insurance pain points, warranty / code gotchas, and value framing —
 *  written in the Voxaris brand register: confident, considered, low
 *  volume. Per the discipline: no buzzwords, no countdowns, no exclamation
 *  marks. NOT a marketing screen — informational. The
 *  customer reads ~5 of these during the ~22s measurement wait, which
 *  makes the bar feel like it's flying. Shuffled at mount so repeat
 *  visitors don't see the same five.
 *
 *  Avoid claims we can't substantiate. Avoid the words "ACT NOW",
 *  countdowns, or fake scarcity — those would clash with the brand and
 *  trigger the customer's BS detector.
 */
const ROOFING_FACTS: string[] = [
  "Florida insurance carriers commonly require roof replacement at 20–25 years to keep coverage active.",
  "Hail over 1.5 inches can void shingle warranties — even when damage isn't visible from the ground.",
  "A new roof typically returns 60–70% of its cost at resale, and homes with newer roofs sell faster.",
  "Architectural shingles last 25–30 years versus 15–20 for 3-tab — and qualify for stronger wind warranties.",
  "Wind-mitigation inspections often save $400–$1,200 a year on Florida homeowners insurance after a new roof.",
  "Cool-roof shingles can drop attic temperatures by 20–40 °F. Your AC runs less and lasts longer.",
  "Roof leaks caught at the attic stage cost about a third as much as ones caught at the ceiling.",
  "Algae streaks shorten shingle life by 5–10 years — and are typically excluded from manufacturer warranties.",
  "Florida's 2007 wind code requires hurricane straps. Older roofs almost always need them added at re-roof.",
  "Skylight leaks are usually the flashing, not the glass seal. Replacement requires both, not one.",
  "Drip edge installed correctly prevents up to 80% of fascia rot from wind-driven rain.",
  "Synthetic underlayment outperforms felt by roughly 4× in wind-uplift testing.",
  "Properly installed shingles withstand 110+ mph winds; uplift damage can start as low as 60 mph.",
  "Florida property insurance premiums rose more than 100% from 2018 to 2024. Roof age is the single biggest lever to bring them back down.",
  "After 15 years, most asphalt roofs have lost enough granules that UV protection is materially reduced.",
  "Most insurance claims for storm damage have a one-year filing window from the date of the event.",
];

export default function HomePage() {
  return (
    <main className="voxaris">
      <BotIdClient protect={[{ path: "/api/leads", method: "POST" }]} />
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
      const res = await fetch(
        `/api/gemini-roof?lat=${pinLat}&lng=${pinLng}&pinConfirmed=1`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Estimate service ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as V3Response;
      setResult(data);
      setStep("result");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStep("error");
    }
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
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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
            marketingConsent: true,
            voiceConsent: false,
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

        {/* Top bar — wordmark only. No nav (how-it-works / FAQ pulled per
            §06 "whitespace is a feature"). The picture element prefers a
            self-hosted brand asset at /brand/voxaris-ai-wordmark.png and
            falls back to the DragonEF text wordmark when the image is
            missing. */}
        <header className="relative z-20 pt-7 lg:pt-10">
          <div className="max-w-7xl mx-auto px-6 lg:px-10 flex justify-center">
            <Link href="/" className="leading-none" aria-label="Voxaris — home">
              <Wordmark size="lg" tone="ink" />
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
              <input
                ref={addrRef}
                type="text"
                className="addr-input"
                placeholder="Begin typing your address…"
                autoComplete="street-address"
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

            <div className="slim-row">
              <div className="slim-cell">
                <label htmlFor="nm" className="field-label">
                  Full name
                </label>
                <input
                  id="nm"
                  className="slim-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Eleanor Whitaker"
                  autoComplete="name"
                  required
                />
              </div>
              <div className="slim-cell">
                <label htmlFor="em" className="field-label">
                  Email address
                </label>
                <input
                  id="em"
                  type="email"
                  className="slim-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="eleanor@whitaker.co"
                  autoComplete="email"
                  required
                />
              </div>
              <div className="slim-cell">
                <label htmlFor="ph" className="field-label">
                  Phone number
                </label>
                <input
                  id="ph"
                  className="slim-input tabular"
                  value={phone}
                  onChange={(e) => setPhone(formatPhone(e.target.value))}
                  placeholder="(239) 555-0117"
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
                  <span style={{ color: "var(--vx-ink)", fontWeight: 500 }}>Send me my estimate.</span>{" "}
                  I agree to receive my roof estimate by email and a brief text-message intro from
                  your team. Reply{" "}
                  <span style={{ fontWeight: 500, color: "var(--vx-ink)" }}>STOP</span> to opt out anytime.{" "}
                  <Link
                    href="/privacy"
                    className="underline"
                    style={{ textDecorationColor: "var(--vx-muted)", textUnderlineOffset: "2px" }}
                  >
                    Privacy
                  </Link>{" "}
                  ·{" "}
                  <Link
                    href="/terms"
                    className="underline"
                    style={{ textDecorationColor: "var(--vx-muted)", textUnderlineOffset: "2px" }}
                  >
                    Terms
                  </Link>
                  .
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
        zoom: 20,
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
  const pct = Math.min(100, Math.round((elapsed / 22) * 100));

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

  // Advance the fact every ~4.2 sec so 5 facts cycle across the ~22s
  // wait. The remainder of an elapsed slice is used to drive the
  // cross-fade (CSS animation, keyed on factIndex so it re-mounts).
  const FACT_INTERVAL = 4.2;
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
          <div className="mt-3 flex items-center justify-center gap-3">
            <span
              className="tabular"
              style={{
                fontSize: "10.5px",
                letterSpacing: "0.20em",
                textTransform: "uppercase",
                color: "var(--vx-muted)",
              }}
            >
              {Math.min(elapsed, 22)} / 22 sec
            </span>
            <span
              aria-hidden="true"
              style={{
                width: "3px",
                height: "3px",
                background: "var(--vx-muted)",
                borderRadius: "50%",
              }}
            />
            <span
              className="tabular"
              style={{
                fontSize: "10.5px",
                letterSpacing: "0.20em",
                textTransform: "uppercase",
                color: "var(--vx-muted)",
              }}
            >
              {factIndex + 1} / {Math.min(shuffled.length, Math.ceil(22 / FACT_INTERVAL))}
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

  // Pricing — sqft × (1 + suggested waste %) × $7/sqft. Waste is rolled
  // in but the percentage itself is intentionally NOT surfaced to the
  // customer (the internal workbench shows it + the breakdown).
  // Prefer Gemini edge counts over Solar's classifier (Solar tends to
  // misfire on simple gable roofs, returning all-rakes / nothing-else).
  const ridgesHipsLf = geminiEdges?.ridgesHipsLf ?? edges.ridgesHipsLf;
  const valleysLf = geminiEdges?.valleysLf ?? edges.valleysLf;
  const rakesLf = geminiEdges?.rakesLf ?? edges.rakesLf;
  const eavesLf = geminiEdges?.eavesLf ?? edges.eavesLf;

  const waste = useMemo(() => {
    if (sqft == null) return null;
    return calculateSuggestedWaste({
      facetCount: facets.length,
      valleysLf: valleysLf,
      ridgesHipsLf: ridgesHipsLf,
      avgPitchDeg: pitch ?? 22.6,
      totalSqft: sqft,
    });
  }, [sqft, facets.length, valleysLf, ridgesHipsLf, pitch]);

  const price = useMemo(() => {
    if (sqft == null || waste == null) return null;
    // Pass detected roof objects so per-penetration flashing adders
    // (chimney, skylight, HVAC, vents, etc.) roll into the total.
    return calculateCustomerPrice(sqft, waste, objects);
  }, [sqft, waste, objects]);

  const objectCounts = objects.reduce<Record<string, number>>((acc, o) => {
    acc[o.type] = (acc[o.type] ?? 0) + 1;
    return acc;
  }, {});

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
          body: JSON.stringify({
            consent: true,
            disclosureText:
              "Customer authorized an automated outbound voice intro call after viewing their estimate.",
          }),
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

  // Build edge cells lazily — display only when ANY value is present so
  // we don't show a 0/0/0/0 row when classification failed.
  const edgeCells: Array<[string, number | null]> = [
    ["Ridges + hips", ridgesHipsLf ?? null],
    ["Valleys", valleysLf ?? null],
    ["Rakes", rakesLf ?? null],
    ["Eaves", eavesLf ?? null],
  ];
  const anyEdge = edgeCells.some(([, lf]) => lf != null && lf > 0);

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
        </div>

        {/* Painted image — the cyan-outlined roof */}
        {paintedImageBase64 && (
          <div
            className="result-card mt-10 overflow-hidden mx-auto"
            style={{ maxWidth: "780px", aspectRatio: "1 / 1" }}
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
        )}

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
          <span className="chip">
            Stories <span className="chip-value">{derived.stories}</span>
          </span>
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
                  {type} <span className="chip-value tabular">×{count}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Edge LFs — only show when at least one classifier returned a
            non-zero number. Avoids the 0/0/562/0 misfire pattern. */}
        {anyEdge && (
          <div
            className="mt-8 grid grid-cols-2 md:grid-cols-4 max-w-3xl mx-auto"
            style={{
              background: "var(--vx-paper)",
              border: "1px solid var(--vx-rule)",
              borderRadius: "var(--vx-radius-card)",
            }}
          >
            {edgeCells.map(([label, lf], i) => (
              <div
                key={label}
                className="p-5 text-center"
                style={{
                  borderLeft:
                    i % 2 === 0 ? "none" : "1px solid var(--vx-rule)",
                  // On md+ (4 cols), use border-left for every cell except the first;
                  // on sm (2 cols), the alternate-cell rule above already gives us
                  // separators in the correct places.
                }}
              >
                <div className="field-label">{label}</div>
                <div
                  className="font-serif tabular mt-2"
                  style={{
                    fontSize: "28px",
                    color: "var(--vx-ink)",
                    fontWeight: 500,
                  }}
                >
                  {lf != null && lf > 0 ? `${lf} ft` : "—"}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Price block — big total + simple rate line. Waste % is NOT
            surfaced (rolled into the math; internal workbench shows it). */}
        {price && (
          <div
            className="mt-12 mx-auto text-center result-card"
            style={{ maxWidth: "640px", padding: "32px 24px" }}
          >
            <div className="eyebrow mb-3">Estimated investment</div>
            <div
              className="font-serif tabular"
              style={{
                fontSize: "clamp(48px, 7vw, 72px)",
                lineHeight: 1,
                fontWeight: 500,
                color: "var(--vx-ink)",
                letterSpacing: "-0.015em",
              }}
            >
              ${price.total.toLocaleString()}
            </div>
            <div
              className="mt-3 tabular"
              style={{
                fontSize: "14px",
                color: "var(--vx-ink-soft)",
                fontWeight: 600,
              }}
            >
              Range ${price.totalLow.toLocaleString()} – ${price.totalHigh.toLocaleString()}
            </div>
            <div
              className="mt-5 mx-auto"
              style={{
                fontSize: "14px",
                color: "var(--vx-ink-soft)",
                fontWeight: 600,
                maxWidth: "44ch",
              }}
            >
              Architectural shingles · ${ARCHITECTURAL_SHINGLE_RATE_PER_SQFT.toFixed(2)} per
              sq ft installed (tear-off, underlayment, ridge cap, drip edge,
              flashing, labor, disposal).
            </div>
            <div
              className="mt-3 mx-auto font-serif italic"
              style={{
                fontSize: "14px",
                color: "var(--vx-ink-soft)",
                maxWidth: "48ch",
              }}
            >
              Final number depends on deck condition, code-driven upgrades,
              and your exact material selection — confirmed on-site by a
              licensed roofer.
            </div>
          </div>
        )}

        {/* "Get a rep to my door" — post-result voice consent + dispatch.
            TCPA-compliant: the customer hasn't received any automated
            voice call yet, and we capture the consent + disclosure text +
            IP/UA + timestamp at the moment of opt-in before the call is
            placed. Disabled when there's no leadPublicId (lead capture
            failed at form submit). */}
        <div className="mt-12 mx-auto" style={{ maxWidth: "640px" }}>
          {bookingState === "booked" ? (
            <div
              className="result-card text-center"
              style={{
                padding: "28px 24px",
                borderColor: "var(--vx-terra)",
              }}
            >
              <div className="eyebrow mb-2" style={{ color: "var(--vx-terra)" }}>
                You&apos;re on the list
              </div>
              <p
                className="font-serif mx-auto"
                style={{
                  fontSize: "22px",
                  lineHeight: 1.3,
                  color: "var(--vx-ink)",
                  maxWidth: "44ch",
                }}
              >
                A specialist will call you within a few minutes to confirm a
                time. Watch your phone.
              </p>
            </div>
          ) : (
            <div className="result-card" style={{ padding: "24px 22px" }}>
              <div className="eyebrow mb-3">Want a rep at your door?</div>
              <label
                className="flex items-start gap-3 cursor-pointer"
                style={{
                  fontSize: "14px",
                  color: "var(--vx-ink-soft)",
                  lineHeight: 1.6,
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
                  to walk through this estimate and schedule an on-site
                  visit. I can hang up or reply STOP anytime. I understand
                  consent is not required to do business with Voxaris or the
                  partner contractor.
                </span>
              </label>
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={onRePin}
                  style={{
                    fontSize: "12px",
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                    color: "var(--vx-ink-soft)",
                    fontWeight: 600,
                    background: "none",
                    border: 0,
                    cursor: "pointer",
                    padding: "10px 0",
                  }}
                >
                  ← Re-pin
                </button>
                <button
                  type="button"
                  className="btn-terra"
                  disabled={
                    !voiceConsent ||
                    !leadPublicId ||
                    bookingState === "sending"
                  }
                  onClick={bookInPersonEstimate}
                >
                  {bookingState === "sending"
                    ? "Booking…"
                    : "Get a rep to my door"}
                  <span className="arrow" aria-hidden="true">→</span>
                </button>
              </div>
              {!leadPublicId && (
                <p
                  className="mt-3"
                  style={{
                    fontSize: "12px",
                    color: "var(--vx-muted)",
                    fontStyle: "italic",
                  }}
                >
                  We didn&apos;t finish saving your contact info. Refresh and
                  resubmit to enable booking, or call us directly.
                </p>
              )}
              {bookingState === "error" && bookingError && (
                <p
                  className="mt-3"
                  style={{
                    fontSize: "12px",
                    color: "#8a2c2c",
                  }}
                >
                  {bookingError}
                </p>
              )}
            </div>
          )}
        </div>

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
function Wordmark({
  size = "lg",
  tone = "ink",
}: {
  size?: "lg" | "md" | "sm";
  tone?: "ink" | "cream";
}) {
  // Size targets: lg (hero) = ~72px tall, md (page header) = ~48px,
  // sm (compact) = ~32px. The earlier sizes (40 / 28 / 22) were way too
  // small to register as a brand mark.
  const dim = size === "lg" ? 72 : size === "md" ? 48 : 32;
  const color = tone === "ink" ? "var(--vx-ink)" : "var(--vx-cream)";
  const textSize = size === "lg" ? 56 : size === "md" ? 36 : 24;
  return (
    <span className="inline-flex items-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/logo-wordmark-alpha.png"
        alt="Voxaris AI"
        style={{
          height: `${dim}px`,
          width: "auto",
          // The alpha PNG ships in the brand-spec ink color. No filter
          // needed on cream. On the dark footer (tone="cream"), invert
          // to white-on-dark.
          filter:
            tone === "cream" ? "invert(1) brightness(1.2)" : "none",
          display: "block",
        }}
        onError={(e) => {
          // Image missing — fall back to the DragonEF text wordmark.
          (e.currentTarget as HTMLImageElement).style.display = "none";
          const sibling = e.currentTarget.nextElementSibling as HTMLElement | null;
          if (sibling) sibling.style.display = "inline";
        }}
      />
      <span
        className="font-serif tracking-tight"
        style={{
          fontSize: `${textSize}px`,
          color,
          letterSpacing: "-0.02em",
          display: "none",
          lineHeight: 1,
        }}
      >
        Voxaris.
      </span>
    </span>
  );
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
              Premium voice &amp; vision agents
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
                <a href="mailto:hello@voxaris.com">hello@voxaris.com</a>
              </li>
              <li className="tabular">
                <a href="tel:+12395550117">+1 (239) 555 · 0117</a>
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
              <li>Licensed &amp; insured · FL CCC1234567</li>
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
          <span>© MMXXVI Voxaris, Inc.</span>
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
