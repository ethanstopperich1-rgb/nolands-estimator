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

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BotIdClient } from "botid/client";
import { loadGoogle } from "@/lib/google";

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
  // Gemini line-detection edges. When present these are the trusted
  // values; Solar's bbox-derived edges regularly misfire (e.g. 562 ft
  // of rakes with 0 ft eaves on a clear hip roof) because Solar's
  // rotated-bbox polygons don't share precise vertices across adjacent
  // facets, so the classifier can't pair shared edges.
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
    setPinLng(null);
    setResult(null);
    setErrorMsg(null);
  }

  return (
    <>
      {step === "hero" && (
        <HeroScreen
          onAddressResolved={(addr) => {
            setResolved(addr);
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

// ─── Hero (Voxaris brand) ───────────────────────────────────────────────

function HeroScreen({
  onAddressResolved,
}: {
  onAddressResolved: (addr: AddressResolved) => void;
}) {
  const addrRef = useRef<HTMLInputElement>(null);
  const [resolvedAddr, setResolvedAddr] = useState<AddressResolved | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  // US phone progressive formatter — strips non-digits, drops a leading
  // "1" country code, caps at 10 digits, and surfaces as
  // "(407) 819-5809" while the customer is still typing. The server
  // calls toE164() (lib/twilio) before any SMS / call dispatch, so any
  // shape we accept here normalizes downstream — this is purely UX.
  function formatPhoneInput(raw: string): string {
    let digits = raw.replace(/\D/g, "");
    if (digits.startsWith("1") && digits.length === 11) digits = digits.slice(1);
    digits = digits.slice(0, 10);
    if (digits.length === 0) return "";
    if (digits.length < 4) return `(${digits}`;
    if (digits.length < 7) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  // Two-tier TCPA: marketing consent gates lead capture + SMS intro;
  // voice consent (optional, opt-in) gates the outbound automated call.
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [voiceConsent, setVoiceConsent] = useState(false);
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
      // marketingConsent is REQUIRED and gates SMS intro.
      // voiceConsent is OPTIONAL — when true, the server fires an
      // automated outbound call after the SMS intro lands.
      await fetch("/api/leads", {
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
          voiceConsent,
        }),
      }).catch(() => {
        /* Don't block the customer if lead capture fails — they still see their estimate. */
      });
      onAddressResolved(resolvedAddr);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex flex-col min-h-[100dvh]">
      <section className="relative overflow-hidden">
        <div className="ambient" />
        <CrescentSvg />

        {/* Top bar — wordmark is "Voxaris." (period non-negotiable on hero
            per brand §04). Pill nav banned by §06; using flat hairline nav. */}
        <header className="relative z-20 pt-7 lg:pt-10">
          <div className="max-w-7xl mx-auto px-6 lg:px-10">
            <div className="flex flex-col items-center gap-6">
              <Link href="/" className="leading-none" aria-label="Voxaris — home">
                <span
                  className="font-serif tracking-tight"
                  style={{ fontSize: "32px", color: "var(--vx-ink)", letterSpacing: "-0.02em" }}
                >
                  Voxaris.
                </span>
              </Link>
              <nav className="nav-row" aria-label="Primary">
                <a href="#how">How it works</a>
                <a href="#faq">FAQ</a>
              </nav>
            </div>
          </div>
        </header>

        {/* Hero copy */}
        <div className="relative z-10 max-w-5xl mx-auto px-6 lg:px-10 pt-20 lg:pt-28 pb-16 lg:pb-20 text-center">
          <OrnamentSvg />
          <div className="rise mb-10" data-d="1">
            <span className="eyebrow">Thirty seconds · No calls until you ask</span>
          </div>
          <h1
            className="rise font-serif tracking-tight mx-auto"
            data-d="2"
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
            data-d="3"
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
                  onChange={(e) => setPhone(formatPhoneInput(e.target.value))}
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

            {/* Consent 2 — optional. Outbound automated voice call. */}
            <div className="px-[22px] py-4" style={{ borderBottom: "1px solid var(--vx-rule-soft)" }}>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={voiceConsent}
                  onChange={(e) => setVoiceConsent(e.target.checked)}
                />
                <span style={{ fontSize: "12px", color: "var(--vx-ink-soft)", lineHeight: 1.6 }}>
                  <span style={{ color: "var(--vx-ink)", fontWeight: 500 }}>Call me with a quick voice intro.</span>{" "}
                  Optional. I&apos;m OK getting an automated voice call within a few minutes to walk through
                  the estimate. I can hang up or reply STOP anytime.
                </span>
              </label>
            </div>

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

      {/* Brass divider */}
      <div className="flex justify-center py-8" style={{ background: "var(--vx-paper)" }}>
        <span className="inline-flex items-center gap-3" aria-hidden="true">
          <span className="block w-12 h-px" style={{ background: "rgba(138, 126, 104, 0.5)" }} />
          <span className="marker" />
          <span className="block w-12 h-px" style={{ background: "rgba(138, 126, 104, 0.5)" }} />
        </span>
      </div>

      <BelowFold />
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

      <div className="relative z-10 max-w-3xl mx-auto px-6 lg:px-10 pt-16 lg:pt-24 pb-10 w-full text-center flex-1 flex flex-col">
        {/* Tiny status — the "what we're doing right now" line. */}
        <div className="eyebrow mb-3">Measuring · {message}</div>

        {/* Headline framing — stable, sets the moment. */}
        <h2
          className="font-serif tracking-tight mx-auto"
          style={{
            fontSize: "clamp(28px, 4.2vw, 44px)",
            lineHeight: 1.06,
            fontWeight: 500,
            color: "var(--vx-ink)",
            maxWidth: "22ch",
          }}
        >
          A few seconds.{" "}
          <span className="italic font-light" style={{ color: "var(--vx-ink-soft)" }}>
            Worth knowing while you wait.
          </span>
        </h2>

        {/* Fact carousel — the main event. Cross-fade keyed on index
            via the `rise` animation re-mounting with a new key. */}
        <div className="flex-1 flex items-center justify-center my-10 lg:my-16">
          <div
            key={factIndex}
            className="rise"
            style={{ maxWidth: "60ch" }}
            data-d="1"
          >
            <span
              className="marker mb-5 inline-block"
              aria-hidden="true"
              style={{ verticalAlign: "middle" }}
            />
            <p
              className="font-serif mx-auto"
              style={{
                fontSize: "clamp(22px, 3vw, 30px)",
                lineHeight: 1.4,
                fontWeight: 400,
                color: "var(--vx-ink)",
                fontStyle: "italic",
              }}
            >
              {fact}
            </p>
          </div>
        </div>

        {/* Progress + counter pinned near the bottom. */}
        <div className="mt-auto">
          <div
            className="mx-auto"
            style={{
              maxWidth: "420px",
              height: "1px",
              background: "var(--vx-rule)",
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: 0,
                width: `${pct}%`,
                background: "var(--vx-muted)",
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
  onRePin,
  onStartOver,
}: {
  result: V3Response;
  resolved: AddressResolved;
  onRePin: () => void;
  onStartOver: () => void;
}) {
  const {
    solar,
    paintedImageBase64,
    objects,
    facets,
    derived,
    edges,
    geminiEdges,
    correction,
  } = result;
  const sqft = solar.sqft;
  const pitch = solar.pitchDegrees;
  const pitchOn12 = pitch != null && pitch > 0
    ? `${Math.max(1, Math.round(Math.tan((pitch * Math.PI) / 180) * 12))}/12`
    : null;

  // Object counts by type for chip strip
  const objectCounts = objects.reduce<Record<string, number>>((acc, o) => {
    acc[o.type] = (acc[o.type] ?? 0) + 1;
    return acc;
  }, {});

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

        {/* Painted image — the Gemini cyan overlay */}
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

        {/* Measurement chips */}
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          {pitch != null && (
            <span className="chip">
              Pitch <span className="chip-value">{pitchOn12 ?? `${Math.round(pitch)}°`}</span>
            </span>
          )}
          {facets.length > 0 && (
            <span className="chip">
              Facets <span className="chip-value">{facets.length}</span>
            </span>
          )}
          <span className="chip">
            Stories <span className="chip-value">{derived.stories}</span>
          </span>
          <span className="chip">
            Complexity <span className="chip-value">{derived.complexity}</span>
          </span>
          {derived.predominantCompass && (
            <span className="chip">
              Faces <span className="chip-value">{derived.predominantCompass}</span>
            </span>
          )}
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

        {/* Edge LFs — Gemini line-detection preferred; Solar fallback
            only when its values look plausible (no single bucket >70%
            of total AND eaves > 0). The 562-ft-rakes / 0-ft-eaves case
            from Solar bbox geometry is hidden entirely rather than
            displayed as fake data. */}
        {(() => {
          const g = geminiEdges;
          const s = edges;
          const solarVals = [s.ridgesHipsLf, s.valleysLf, s.rakesLf, s.eavesLf];
          const solarTotal = solarVals.reduce<number>((a, v) => a + (v ?? 0), 0);
          const solarMax = Math.max(...solarVals.map((v) => v ?? 0));
          const solarLooksSane =
            solarTotal > 0 &&
            solarMax / solarTotal < 0.7 &&
            (s.eavesLf ?? 0) > 0;

          let rows: Array<[string, number | null]> | null = null;
          if (g) {
            rows = [
              ["Ridges + hips", g.ridgesHipsLf],
              ["Valleys", g.valleysLf],
              ["Rakes", g.rakesLf],
              ["Eaves", g.eavesLf],
            ];
          } else if (solarLooksSane) {
            rows = [
              ["Ridges + hips", s.ridgesHipsLf],
              ["Valleys", s.valleysLf],
              ["Rakes", s.rakesLf],
              ["Eaves", s.eavesLf],
            ];
          }
          if (!rows) return null;
          return (
            <div
              className="mt-8 grid grid-cols-2 md:grid-cols-4 gap-px max-w-3xl mx-auto"
              style={{ background: "var(--vx-rule)", border: "1px solid var(--vx-rule)" }}
            >
              {rows.map(([label, lf]) => (
                <div
                  key={label as string}
                  className="p-5 text-center"
                  style={{ background: "var(--vx-cream)" }}
                >
                  <div className="field-label">{label}</div>
                  <div
                    className="font-serif tabular mt-2"
                    style={{ fontSize: "28px", color: "var(--vx-ink)", fontWeight: 500 }}
                  >
                    {lf != null ? `${lf} ft` : "—"}
                  </div>
                </div>
              ))}
            </div>
          );
        })()}

        {/* Correction audit — only shown when transparent fallback fired */}
        {correction?.applied && (
          <div
            className="mt-8 mx-auto"
            style={{
              maxWidth: "640px",
              border: "1px solid var(--vx-rule-soft)",
              padding: "16px 20px",
              fontSize: "12.5px",
              lineHeight: 1.6,
              color: "var(--vx-ink-soft)",
            }}
          >
            <span className="eyebrow" style={{ display: "block", marginBottom: 6 }}>
              How we got here
            </span>
            {correction.reason}
          </div>
        )}

        <div className="mt-12 flex flex-wrap items-center justify-center gap-4">
          <button
            type="button"
            onClick={onRePin}
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
            ← Re-pin building center
          </button>
          <button type="button" className="btn-terra" onClick={onStartOver}>
            Estimate another address
            <span className="arrow" aria-hidden="true">→</span>
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

// ─── Below-the-fold (How It Works + FAQ) ───────────────────────────────

function BelowFold() {
  return (
    <>
      <main className="relative z-10">
        <section id="how" className="scroll-mt-20" style={{ background: "var(--vx-paper)" }}>
          <div className="max-w-5xl mx-auto px-6 lg:px-10 py-24 lg:py-32">
            <div className="text-center max-w-2xl mx-auto">
              <div className="eyebrow">How it works</div>
              <h2
                className="font-serif tracking-tight mt-4"
                style={{ fontSize: "clamp(40px, 6vw, 56px)", lineHeight: 1.04, fontWeight: 500, color: "var(--vx-ink)" }}
              >
                Three steps.{" "}
                <span className="italic" style={{ fontWeight: 300 }}>About thirty seconds.</span>
              </h2>
              <p className="mt-5 mx-auto" style={{ fontSize: "16px", color: "var(--vx-ink-soft)", fontWeight: 300, lineHeight: 1.6, maxWidth: "32rem" }}>
                No measuring tape. No salesperson at your door.
              </p>
            </div>
            <ol className="mt-20 relative">
              <span
                aria-hidden="true"
                className="absolute"
                style={{
                  left: "44px", top: "24px", bottom: "24px", width: "1px",
                  background: "linear-gradient(to bottom, transparent, rgba(138, 126, 104, 0.4), transparent)",
                }}
              />
              {[
                ["01", "Enter your address", "Just your street address. We instantly pull your roof from satellite imagery the moment you submit."],
                ["02", "AI measures your roof", "Our proprietary segmentation calculates square footage, pitch, and roof complexity in seconds."],
                ["03", "Your estimate appears", "Choose your preferred material and see your price range — in writing, in seconds. No follow-up unless you ask."],
              ].map(([num, title, body]) => (
                <li key={num} className="relative grid grid-cols-[88px_1fr] gap-10 py-12 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-center">
                    <span
                      className="font-serif tabular"
                      style={{ fontSize: "64px", lineHeight: 1, letterSpacing: "-0.04em", fontWeight: 300, color: "var(--vx-ink)" }}
                    >
                      {num}
                    </span>
                  </div>
                  <div>
                    <h3 className="font-serif" style={{ fontSize: "28px", fontWeight: 500, color: "var(--vx-ink)", lineHeight: 1.2 }}>
                      {title}
                    </h3>
                    <p className="mt-3" style={{ fontSize: "16px", color: "var(--vx-ink-soft)", fontWeight: 300, lineHeight: 1.75, maxWidth: "58ch" }}>
                      {body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <hr className="hair-strong" />

        <section id="faq" className="scroll-mt-20">
          <div className="max-w-3xl mx-auto px-6 lg:px-10 py-24 lg:py-32">
            <div className="text-center mb-14">
              <div className="eyebrow">Honestly answered</div>
              <h2
                className="font-serif tracking-tight mt-4"
                style={{ fontSize: "clamp(36px, 5vw, 48px)", lineHeight: 1.05, fontWeight: 500, color: "var(--vx-ink)" }}
              >
                What you&apos;d reasonably want to know.
              </h2>
            </div>
            <div style={{ borderTop: "1px solid var(--vx-rule)" }}>
              {[
                ["How accurate is the number?", "The estimate is a satellite-measured starting point — typically within a 10–15% band of an on-site quote on standard residential roofs, wider on complex or large properties. A binding contract still requires a master roofer on the property."],
                ["Is this truly free?", "Yes. The estimate is complimentary. There is no fee, deposit, or obligation, and you are never charged for the on-site visit if you choose to request one."],
                ["Will I be spammed or cold-called?", "No. Your details are never sold, never syndicated. No one follows up unless you ask, and a single reply of STOP ends contact immediately."],
              ].map(([q, a], i) => (
                <details key={q} className="group" style={{ borderBottom: "1px solid var(--vx-rule-soft)" }} open={i === 0}>
                  <summary className="flex items-center justify-between gap-8 py-7 cursor-pointer list-none">
                    <span className="font-serif" style={{ fontSize: "22px", color: "var(--vx-ink)", lineHeight: 1.2 }}>
                      {q}
                    </span>
                    <span
                      className="group-open:rotate-45 transition-transform"
                      style={{ color: "var(--vx-muted)", fontSize: "24px", fontWeight: 300, lineHeight: 1 }}
                      aria-hidden="true"
                    >
                      +
                    </span>
                  </summary>
                  <p className="pb-7 -mt-1" style={{ fontSize: "15.5px", color: "var(--vx-ink-soft)", fontWeight: 300, lineHeight: 1.75, maxWidth: "68ch" }}>
                    {a}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <div className="flex justify-center pt-2 pb-12">
          <span className="inline-flex items-center gap-3" aria-hidden="true">
            <span className="block w-12 h-px" style={{ background: "rgba(138, 126, 104, 0.5)" }} />
            <span className="marker" />
            <span className="block w-12 h-px" style={{ background: "rgba(138, 126, 104, 0.5)" }} />
          </span>
        </div>

        <hr className="hair-strong" />
      </main>
    </>
  );
}

// ─── Shared chrome ──────────────────────────────────────────────────────

function PinHeader({ onBack }: { onBack?: () => void } = {}) {
  return (
    <header className="relative z-20 pt-7 lg:pt-10">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 flex items-center justify-between">
        <Link href="/" className="leading-none" aria-label="Voxaris — home">
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
              <span
                className="font-serif"
                style={{
                  fontSize: "32px",
                  color: "var(--vx-cream)",
                  lineHeight: 1,
                  letterSpacing: "-0.02em",
                }}
              >
                Voxaris.
              </span>
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
