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
// Framer Motion v12 — already a dependency. Used for the two-step
// form swap + the sticky mobile CTA enter/exit. useReducedMotion
// short-circuits transitions for users with the OS-level preference
// set, satisfying the vestibular accessibility note in globals.css.
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { LanguageToggle, useLanguage } from "@/components/LanguageToggle";
import { t } from "@/lib/i18n";
import { BRAND_CONFIG } from "@/lib/branding";
import {
  AGENT_DISPLAY_NAME,
  AGENT_CALLER_ID_E164,
  AGENT_CALLER_ID_FORMATTED,
  MAIN_PHONE_E164,
  MAIN_PHONE_FORMATTED,
  PRICING_CONFIRMED,
} from "@/lib/agent-config";
import { buildMarketingConsentText } from "@/lib/tcpa-consent";
import Link from "next/link";
import { BotIdClient } from "botid/client";
import { loadGoogle } from "@/lib/google";
import { useRecaptcha } from "@/lib/useRecaptcha";
import { Wordmark as SharedWordmark } from "@/components/Wordmark";
import RoofMap from "@/components/RoofMap";
import { ROOFING_FACTS } from "@/lib/roofing-facts";
import {
  buildFaqJsonLd,
  // buildServiceJsonLd — emitted by app/layout.tsx now so /privacy + /terms
  // also carry the Service node. Don't re-emit here.
  buildHomeBreadcrumbJsonLd,
  buildHomeWebPageJsonLd,
  jsonLdToScriptContent,
} from "@/lib/seo/structured-data";
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
  /** City extracted from Google Places address_components (locality
   *  field). Null when Places didn't return a locality match (rural
   *  addresses) or when the user typed an address without picking
   *  from the dropdown. Flows through /api/leads → leads.city → JN
   *  contact.city so reps can filter the JN contacts list by city
   *  without parsing the address string. */
  city: string | null;
  /** US state postal abbreviation (FL, GA, etc.) extracted from
   *  Google Places administrative_area_level_1.short_name. Null on
   *  the same paths as city. Maps to leads.state → JN contact.state_text. */
  state: string | null;
  /** Postal code from Google Places postal_code component. Null on
   *  the same paths. Maps to leads.zip → JN contact.zip. */
  zip: string | null;
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
  /** Cyan polygon as a TRANSPARENT-BACKGROUND PNG + lat/lng bounds for
   *  GroundOverlay use on an interactive Google Maps view. Null when
   *  Gemini didn't produce a usable cyan mask; in that case the
   *  frontend renders the interactive satellite map without overlay. */
  cyanOverlay?: {
    base64: string;
    bounds: { north: number; south: number; east: number; west: number };
    widthPx: number;
    heightPx: number;
  } | null;
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
  /** Customer-facing roof condition signal — Pro reading the top-down
   *  + a Street View pano of the same building. Null on any failure or
   *  identity-gate trip. Renderer MUST hedge ("appears to be") and
   *  defer to rep on-site (legal framing — see V3 route comment). */
  visualRoofAssessment?: {
    primaryMaterial: string;
    conditionObservations: string[];
    confidence: "high" | "medium" | "low";
    observationNotes: string | null;
    streetViewVerified: boolean;
    streetViewDate: string | null;
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

// CRO P1.1 — extended to 8 entries covering 0–33s of the pipeline.
// Prior version stopped advancing at 19s while the V3 pipeline can
// take up to ~30s (Pro Image 25–35s tail), creating an 11s "stuck"
// window that drove ~10% loading-step abandonment. New entries are
// honest about what the pipeline is doing per phase, and the {street}
// placeholder lets LoadingScreen personalize the message with the
// homeowner's actual address — tells the customer we're working on
// THEIR roof, not running a demo.
const LOADING_MESSAGES: Array<{ at: number; text: string }> = [
  { at: 0,  text: "Fetching satellite imagery for {street}…" },
  { at: 3,  text: "Measuring the roof outline…" },
  { at: 7,  text: "Tracing each roof face…" },
  { at: 13, text: "Detecting vents, chimneys, and HVAC…" },
  { at: 19, text: "Cross-checking with Florida property records…" },
  { at: 24, text: "Pulling recent severe-weather events…" },
  { at: 28, text: "Calculating your four options…" },
  { at: 33, text: "Almost there — just packaging it up…" },
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
  // Homepage-specific JSON-LD — FAQPage + Service + BreadcrumbList.
  // Site-wide nodes (Organization, SoftwareApplication, WebSite) live
  // in app/layout.tsx so they appear on every page; these three are
  // home-only because the FAQ answers reference what the homepage
  // does specifically, and BreadcrumbList here would conflict with
  // per-subpage breadcrumbs if hoisted to the layout.
  //
  // Rendered as <script type="application/ld+json"> tags inside the
  // initial SSR HTML. Browsers ignore them (no visible UI). AI
  // crawlers + Google's rich-result tester parse them as the
  // canonical source of truth for what this page IS.
  const webPageJsonLd = jsonLdToScriptContent(buildHomeWebPageJsonLd());
  const faqJsonLd = jsonLdToScriptContent(buildFaqJsonLd());
  // Service node moved to app/layout.tsx so /privacy + /terms also
  // carry it (closes "Service schema only on 1 of 3 pages" audit gap).
  const breadcrumbJsonLd = jsonLdToScriptContent(buildHomeBreadcrumbJsonLd());

  return (
    <main className="voxaris">
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger -- WebPage wrapper:
        // author = Voxaris Organization (closes audit gap on author
        // info), mentions = hard product stats (closes audit gap on
        // statistics per page).
        dangerouslySetInnerHTML={{ __html: webPageJsonLd }}
      />
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger -- JSON-LD via
        // typed server-side builder; no user input.
        dangerouslySetInnerHTML={{ __html: faqJsonLd }}
      />
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: breadcrumbJsonLd }}
      />
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
  // EN ↔ ES toggle state. The hook reads URL ?lang= + cookie on
  // mount so SSR and first-paint match. Pass `lang` into both
  // /api/leads POST bodies so the server persists preferred_language
  // on the lead row and sends the right-language confirmation SMS.
  const [lang, setLang] = useLanguage();
  const [step, setStep] = useState<Step>("hero");
  const [resolved, setResolved] = useState<AddressResolved | null>(null);
  const [pinLat, setPinLat] = useState<number | null>(null);
  const [leadPublicId, setLeadPublicId] = useState<string | null>(null);
  const [pinLng, setPinLng] = useState<number | null>(null);
  const [result, setResult] = useState<V3Response | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loadingElapsed, setLoadingElapsed] = useState(0);
  // Stash of the data the hero form POSTed to /api/leads, kept around
  // so the result screen can RETRY the lead capture if the initial
  // submit failed (network blip, server hiccup, etc.). Prior version
  // just showed "Refresh and resubmit" as a dead-end hint with no
  // actionable retry path — customer dropped off.
  const [pendingLeadCapture, setPendingLeadCapture] = useState<{
    name: string;
    email: string;
    phone: string;
    address: string;
    lat: number;
    lng: number;
    officeSlug: string;
  } | null>(null);

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
          lang={lang}
          setLang={setLang}
          onAddressResolved={(addr, leadId, capturePayload) => {
            setResolved(addr);
            setLeadPublicId(leadId ?? null);
            setPinLat(addr.lat);
            setPinLng(addr.lng);
            setPendingLeadCapture(capturePayload);
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
        <LoadingScreen
          elapsed={loadingElapsed}
          message={loadingMessageFor(loadingElapsed)}
          // Pass the street segment of the resolved address (e.g.
          // "8450 Oak Park Ave") so the eyebrow can substitute
          // {street} into the first LOADING_MESSAGES entry. Falls
          // back to "your roof" inside the component if missing.
          streetName={resolved?.formatted?.split(",")[0]?.trim() ?? null}
        />
      )}
      {step === "result" && result && resolved && (
        <ResultScreen
          result={result}
          resolved={resolved}
          leadPublicId={leadPublicId}
          onLeadRecaptured={(id) => setLeadPublicId(id)}
          pendingLeadCapture={pendingLeadCapture}
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

export interface LeadCapturePayload {
  name: string;
  email: string;
  phone: string;
  address: string;
  lat: number;
  lng: number;
  officeSlug: string;
  /** Bilingual journey — carried through the retry path so a Spanish
   *  homeowner who hit a BotID false-positive on first submit still
   *  gets the Spanish confirmation SMS on retry. */
  preferredLanguage?: "en" | "es";
  /** FUNNEL-2 — city + state + zip pulled from Google Places
   *  address_components. Carried through the retry path so a re-submit
   *  doesn't lose them. Nullable when Places didn't return them. */
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

function HeroScreen({
  onAddressResolved,
  lang,
  setLang,
}: {
  onAddressResolved: (
    addr: AddressResolved,
    leadId: string | null,
    capturePayload: LeadCapturePayload,
  ) => void;
  /** Current EN/ES preference from the parent VoxarisFlow. Forwarded
   *  into /api/leads body + into the LeadCapturePayload stash so a
   *  retry on the result page preserves the language. */
  lang: "en" | "es";
  /** Setter so the in-header LanguageToggle can update the parent's
   *  state (which propagates back to HeroScreen's lang prop on next
   *  render). Keeps lang state single-source-of-truth in
   *  VoxarisFlow. */
  setLang: (next: "en" | "es") => void;
}) {
  const addrRef = useRef<HTMLInputElement>(null);
  const [resolvedAddr, setResolvedAddr] = useState<AddressResolved | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  // CRO HI-1 — two-step form. Step 1 captures address only (a 1-second
  // micro-commitment); step 2 reveals name/email/phone + consent. The
  // foot-in-the-door yields a 15-25% lift over single-page forms with
  // >3 fields. Lives in the HeroScreen because the address row is the
  // foot-in-the-door surface; pinning + result step are independent
  // of this state.
  const [formStep, setFormStep] = useState<1 | 2>(1);
  // Respect the OS-level "reduce motion" preference. When true, the
  // step swap snaps instead of animating. Same accessibility note
  // that lives in app/globals.css around the `prefers-reduced-motion`
  // CSS query — keep client + CSS aligned.
  const prefersReducedMotion = useReducedMotion();
  // Shared transition for the step swap. Tween (not spring) so the
  // distance traveled stays predictable on a narrow form card.
  const stepTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: 0.22, ease: [0.4, 0, 0.2, 1] as const };
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
          // FUNNEL-2 — request address_components so we can extract
          // city + state + zip directly from Places instead of asking
          // JobNimbus to parse the formatted_address string. Mapped
          // through to leads.city / leads.state / leads.zip in the
          // /api/leads insert.
          fields: ["formatted_address", "geometry", "address_components"],
        });
        ac.addListener("place_changed", () => {
          const place = ac!.getPlace();
          const loc = place.geometry?.location;
          if (!loc) return;
          // Pull city + state + zip from the address_components array.
          // Each component has a `types` array — match on:
          //   - locality            → city long_name
          //   - administrative_area_level_1 → state short_name (FL, GA, …)
          //   - postal_code         → zip long_name
          // Some rural addresses don't return a locality; fall back to
          // sublocality / postal_town when present. Nullable on all
          // three — downstream handlers treat null as "unknown."
          const comps = place.address_components ?? [];
          const pick = (typeName: string, short = false): string | null => {
            const c = comps.find((x) => x.types.includes(typeName));
            if (!c) return null;
            const v = (short ? c.short_name : c.long_name) ?? "";
            return v.trim() || null;
          };
          const city =
            pick("locality") ?? pick("sublocality") ?? pick("postal_town");
          const state = pick("administrative_area_level_1", true);
          const zip = pick("postal_code");
          setResolvedAddr({
            formatted: place.formatted_address ?? addrRef.current!.value,
            lat: loc.lat(),
            lng: loc.lng(),
            city,
            state,
            zip,
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
    // Step 1 → step 2 advance. Only the address has to validate at
    // this point; consent + contact details are step 2. Pressing
    // Enter in the address field also hits this path (form submit
    // delegates here), which is the desired UX.
    if (formStep === 1) {
      if (!resolvedAddr) {
        setFormError("Please pick your address from the dropdown.");
        return;
      }
      setFormStep(2);
      return;
    }
    // Step 2 — the original full validation + submit.
    if (!resolvedAddr) {
      setFormError("Please pick your address from the dropdown.");
      // Defensive: hop back to step 1 so the user can re-pick. Should
      // be impossible in normal flow but guards against state drift.
      setFormStep(1);
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
            // FUNNEL-2 — Places-derived city/state/zip. Server-side
            // /api/leads stores these on the leads row, then
            // /api/gemini-roof V3 reads them and passes through to the
            // JobNimbus createContact call so reps can filter JN's
            // contacts list by city directly.
            city: resolvedAddr.city,
            state: resolvedAddr.state,
            zip: resolvedAddr.zip,
            source: "estimate.nolandsroofing.com",
            office: officeSlug,
            marketingConsent: true,
            voiceConsent: false,
            // Lang from the EN/ES toggle — persisted on the lead row
            // so the confirmation SMS, share URL, and Sydney callback
            // all speak the homeowner's language.
            preferredLanguage: lang,
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
      // Pass the form data through so the result screen can RETRY the
      // capture if leadPublicId came back null (network blip, server
      // hiccup, BotID false-positive, etc.). recaptchaToken is single-
      // use and we don't re-issue here — retry path will mint a new
      // token on demand.
      onAddressResolved(resolvedAddr, leadPublicId, {
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        address: resolvedAddr.formatted,
        lat: resolvedAddr.lat,
        lng: resolvedAddr.lng,
        officeSlug,
        preferredLanguage: lang,
        // FUNNEL-2 retry-path parity — if the first /api/leads POST
        // failed (BotID false-positive, network blip), the retry on
        // the result page needs the same city/state/zip values.
        city: resolvedAddr.city,
        state: resolvedAddr.state,
        zip: resolvedAddr.zip,
      });
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
              aria-label="Noland's Roofing — home"
            >
              {/* Header wordmark now matches the footer's `size="lg"`
                  for symmetric brand bookends. Earlier corner-mark
                  treatment (size="sm" 32px) read as a tiny chip; the
                  footer carries the brand at 140px so the header
                  should too. */}
              <Wordmark size="lg" tone="ink" />
            </Link>
            <div className="flex items-center gap-3">
              {/* EN ↔ ES toggle — customer-facing only, persists via
                  cookie + URL so server-rendered surfaces (share URL,
                  /api/leads SMS body) see the same preference. */}
              <LanguageToggle value={lang} onChange={setLang} />
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
                  // Mobile-friendly tap target: 40px height with comfortable
                  // horizontal padding. Was 29px (8px×2 + 13px font) which
                  // failed Apple HIG 44pt minimum and felt cramped on phone.
                  padding: "12px 16px",
                  minHeight: "40px",
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
          </div>
        </header>

        {/* Hero copy */}
        <div className="relative z-10 max-w-5xl mx-auto px-6 lg:px-10 pt-24 lg:pt-32 pb-16 lg:pb-20 text-center">
          <OrnamentSvg />
          {/* Brand promise tag — sets the time expectation before the
              homeowner submits anything. If the pipeline ever runs
              longer than this, that's a regression worth fixing in the
              route, not a copy change here. The corresponding "≈ 30
              sec" badge next to the address input echoes this promise
              at the exact moment they're about to commit. */}
          <div
            className="rise eyebrow mb-6"
            data-d="1"
            style={{ color: "var(--vx-terra)" }}
          >
            {t("hero.eyebrow", lang)}
          </div>
          {/* Noland's-native H1 — Poppins Black for the main line (matches
              the NOLAND'S logo letterforms), fire-orange for "in 30
              seconds" so the value prop reads as a single visual
              accent. Replaces the italic-serif Patek treatment that
              was inherited from the upstream Voxaris demo. */}
          <h1
            className="rise font-serif tracking-tight mx-auto"
            data-d="1"
            style={{
              fontSize: "clamp(54px, 8.2vw, 120px)",
              lineHeight: 0.94,
              fontWeight: 900,
              color: "var(--vx-ink)",
              maxWidth: "14ch",
              textTransform: "uppercase",
              letterSpacing: "-0.02em",
            }}
          >
            {t("hero.headline.line1", lang)}
            <span
              className="block"
              style={{ fontWeight: 800, color: "var(--vx-terra)" }}
            >
              {t("hero.headline.line2", lang)}
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
            {t("hero.subhead.lead", lang)}{" "}
            <span className="font-serif italic" style={{ color: "var(--vx-ink)" }}>
              {t("hero.subhead.close", lang)}
            </span>
          </p>

          {/* Trust credential strip — mirrors the primary trust anchors from
              nolandsroofing.com (the "25+ years" and "CertainTeed Triple
              Crown Champion" signals that close roofing sales on the main
              site). Keeps the estimator feeling like one product, not two.
              Deliberately small + muted so it doesn't compete with the H1. */}
          <div
            className="rise flex flex-wrap items-center justify-center gap-x-6 gap-y-2 mt-7"
            data-d="3"
            style={{
              fontSize: "11px",
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              fontWeight: 700,
              color: "var(--vx-ink-soft)",
            }}
          >
            <span>25+ Years in Florida</span>
            <span aria-hidden="true" style={{ color: "var(--vx-terra)" }}>·</span>
            {/* CertainTeed Premier Roofing Contractor is the top-tier
                credential — verified May 2026 against Noland's paper
                estimate (`Nolands_Roofing_Estimator.pdf`): "only TWO
                roofing contractors in all of Central Florida have
                earned this." Previous copy "Triple Crown Champion"
                was an adjacent credential, not the one Noland's
                anchors on. CRO win — anti-status authority signal
                that hits stronger than a "top 1%" generic claim. */}
            <span>
              CertainTeed Premier Contractor
              <span style={{ color: "var(--vx-muted)", fontWeight: 500 }}>
                {" "}(only 2 in Central Florida)
              </span>
            </span>
            <span aria-hidden="true" style={{ color: "var(--vx-terra)" }}>·</span>
            <span>Licensed General Contractor</span>
          </div>
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
                {t("form.address.label", lang)}
              </label>
              <input
                ref={addrRef}
                id="voxaris-address-input"
                type="text"
                className="addr-input"
                placeholder={t("form.address.placeholder", lang)}
                autoComplete="street-address"
                aria-label={t("form.address.label", lang)}
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
                {t("form.address.eta", lang)}
              </span>
            </div>

            {/* CRO HI-1 — animated step swap via AnimatePresence.
                `mode="wait"` ensures step 1 fully exits before step 2
                enters, so the form card height changes smoothly rather
                than ghosting two blocks on top of each other.
                Horizontal slide (step 1 exits left, step 2 enters from
                right) reads as forward progress; opacity ramp prevents
                input flash. layout="position" lets the form's own
                height auto-adjust without jank. */}
            <AnimatePresence mode="wait" initial={false}>
              {formStep === 1 ? (
                <motion.div
                  key="step1"
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -12 }}
                  transition={stepTransition}
                >
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
                      <span>Step 1 of 2 · Address</span>
                    </div>
                    <button
                      type="submit"
                      className="btn-terra"
                      disabled={!resolvedAddr}
                      title={
                        resolvedAddr
                          ? "Continue to contact details"
                          : "Pick your address from the dropdown first"
                      }
                    >
                      Continue
                      <span className="arrow" aria-hidden="true">→</span>
                    </button>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="step2"
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 12 }}
                  transition={stepTransition}
                >
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
                  {t("form.name.label", lang)}
                </label>
                <input
                  id="nm"
                  className="slim-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("form.name.placeholder", lang)}
                  autoComplete="name"
                  required
                />
              </div>
              <div className="slim-cell">
                <label htmlFor="em" className="sr-only">
                  {t("form.email.label", lang)}
                </label>
                <input
                  id="em"
                  type="email"
                  className="slim-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t("form.email.placeholder", lang)}
                  autoComplete="email"
                  required
                />
              </div>
              <div className="slim-cell">
                <label htmlFor="ph" className="sr-only">
                  {t("form.phone.label", lang)}
                </label>
                <input
                  id="ph"
                  className="slim-input tabular"
                  value={phone}
                  onChange={(e) => setPhone(formatPhone(e.target.value))}
                  placeholder={t("form.phone.placeholder", lang)}
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
                    {t("consent.privacy_link", lang)}
                  </Link>{" "}
                  ·{" "}
                  <Link
                    href="/terms"
                    className="underline"
                    style={{ textDecorationColor: "var(--vx-muted)", textUnderlineOffset: "2px" }}
                  >
                    {t("consent.terms_link", lang)}
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
                <span>Step 2 of 2 · {t("form.foot.tagline", lang)}</span>
              </div>
              <button type="submit" className="btn-terra" disabled={submitting}>
                {submitting
                  ? t("form.cta.estimating", lang)
                  : t("form.cta.estimate", lang)}
                <span className="arrow" aria-hidden="true">→</span>
              </button>
            </div>

            {/* Back-to-step-1 link. Ghost styling so it doesn't
                compete with the final submit. Lets a customer who
                mis-typed their address re-pick without abandoning. */}
            <div
              className="px-[22px] pb-3 text-left"
              style={{ borderTop: "1px solid var(--vx-rule-soft)" }}
            >
              <button
                type="button"
                onClick={() => {
                  setFormError(null);
                  setFormStep(1);
                }}
                style={{
                  marginTop: "10px",
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
                ← Edit address
              </button>
            </div>
                </motion.div>
              )}
            </AnimatePresence>

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

function LoadingScreen({
  elapsed,
  message,
  streetName,
}: {
  elapsed: number;
  message: string;
  /** CRO P1.1 — homeowner's street (first comma-segment of the
   *  resolved address). Substituted into any LOADING_MESSAGES entry
   *  that contains "{street}". Null in legacy callers; render falls
   *  back to "your roof". */
  streetName?: string | null;
}) {
  // Substitute the personalization placeholder. Done here (not in
  // loadingMessageFor) so the message constant stays parameterized
  // and the substitution is the LoadingScreen's responsibility.
  const personalizedMessage = message.replace(
    /\{street\}/g,
    streetName?.trim() || "your roof",
  );
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
          {/* Status line — small, muted, sits well above the fact.
              CRO P1.1: now uses personalizedMessage which substitutes
              {street} with the homeowner's actual street name. */}
          <div className="eyebrow mb-10">Measuring · {personalizedMessage}</div>

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
  onLeadRecaptured,
  pendingLeadCapture,
  onRePin,
  onStartOver,
}: {
  result: V3Response;
  resolved: AddressResolved;
  leadPublicId: string | null;
  /** Called after a successful retry submission so the parent flow
   *  can update its leadPublicId state and re-enable booking. */
  onLeadRecaptured: (publicId: string) => void;
  /** Form data captured on the hero submit, kept around so the result
   *  screen can retry /api/leads when the initial submit didn't return
   *  a publicId. Null in legacy flows (e.g. dev where the user pasted
   *  a URL straight to the result step). */
  pendingLeadCapture: LeadCapturePayload | null;
  onRePin: () => void;
  onStartOver: () => void;
}) {
  const { solar, paintedImageBase64, objects, facets, derived } = result;
  const sqft = solar.sqft;
  // pitchDegrees + pitchOn12 derivation removed from customer view —
  // Solar's per-facet pitch was unreliable on complex roofs and the
  // chip didn't help homeowners decide anything. Rep dashboard still
  // surfaces pitch from `solar.pitchDegrees` directly.

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
  // Pricing-eligible sqft. We price on the FULL headline `sqft`, not
  // the ≥12° "quotable" subset. Reason: Solar API's per-facet pitch
  // estimate is unreliable on complex Florida roofs (8450 Oak Park
  // showed a 1,130 sqft "low-slope" carve-out that was wrong, leading
  // to under-quoted tier prices on a 5,487 sqft roof). The rep adjusts
  // for actual flat sections on-site during the 20-minute walkthrough —
  // that's where the lanai / pool-cage / TPO call belongs, not in a
  // satellite-derived auto-split. `quotableSqft` stays in the V3
  // response for rep-dashboard use, just not surfaced to the customer.
  const pricingSqft = sqft;
  const tiers: TierPrice[] | null = useMemo(() => {
    if (pricingSqft == null) return null;
    const wastePercent = result.pricing?.recommendedWastePercent ?? 10;
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
  const visualRoofAssessment = result.visualRoofAssessment ?? null;
  const [storms, setStorms] = useState<RecentStormsResponse | null>(null);
  // Tracks whether the storms fetch is in flight. Used by StormsBlock
  // to show a 3-line skeleton until the IEM mirror responds, so the
  // bottom-left quadrant doesn't pop in late and shift the layout as
  // the customer is reading.
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

  // CRO HI-4 — ref for the sticky mobile CTA bar. Points at the
  // wrapper around RepCTACard so the IntersectionObserver inside
  // StickyMobileCTA can decide visibility (off-screen → show bar),
  // and so tapping the bar can smooth-scroll the customer to the
  // real CTA + focus the consent checkbox.
  const repCtaRef = useRef<HTMLDivElement>(null);

  // CRO QW-2 — social-proof count for the RepCTACard. Fetched once on
  // result mount. Endpoint caches 15 min at the edge, so this is
  // cheap. Stays null on any failure path; RepCTACard only renders
  // the line when count ≥ 5 (small numbers feel fabricated).
  const [recentLeadCount, setRecentLeadCount] = useState<number | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/leads/recent-count?days=7&office=nolands", {
      signal: ctrl.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { count: number | null } | null) => {
        if (d && typeof d.count === "number") setRecentLeadCount(d.count);
      })
      .catch(() => {
        // Soft-fail — line just doesn't render.
      });
    return () => ctrl.abort();
  }, []);

  // Per-zip job count from JobNimbus — the homeowner sees "Noland's
  // completed N reroofs in your zip code recently" above the tier
  // cards. Powered by /api/social-proof/jobs-by-zip which queries
  // JN's job history (won statuses, last 365 days) for the zip
  // extracted from the resolved formatted address. Mimetic-desire
  // + local-relevance social proof at the highest-converting moment.
  //
  // Gates: only renders when count ≥ 3 (smaller numbers feel weak).
  // Endpoint caches 24h at the edge so this is cheap per pageview.
  const [zipJobCount, setZipJobCount] = useState<number | null>(null);
  useEffect(() => {
    // Extract 5-digit zip from the formatted address ("818 Oak St,
    // Orlando FL 32827" → "32827"). Robust regex anchors on a 5-digit
    // group preceded by 1-2 spaces (the typical "ST 32827" pattern).
    // Falls back to null if the address didn't include a zip.
    const m = resolved.formatted.match(/\b(\d{5})\b/);
    const zip = m?.[1];
    if (!zip) return;
    const ctrl = new AbortController();
    fetch(`/api/social-proof/jobs-by-zip?zip=${zip}`, {
      signal: ctrl.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { count: number | null } | null) => {
        if (d && typeof d.count === "number") setZipJobCount(d.count);
      })
      .catch(() => {
        // Soft-fail — line just doesn't render.
      });
    return () => ctrl.abort();
  }, [resolved.formatted]);

  // Tier accordion: which tier card is currently expanded. Prior version
  // gave each TierRow its own open state, so clicking a row only added
  // to the expansion without closing others — causing the top-row cards
  // (map / tier prices) to grow vertically as multiple tiers expanded
  // and breaking the symmetric 2×2 grid. Single source of truth here
  // gives accordion behavior: open one, close any other.
  // Default all tier cards collapsed so the row reads with equal heights.
  // Previously defaulted to "better" (Standard) which auto-expanded the
  // middle card on first paint — created a noticeable height mismatch
  // against Essentials + Fortified (cards looked broken/asymmetric).
  // Homeowner can open any card by tapping "What else is included →".
  const [openTierId, setOpenTierId] = useState<string | null>(null);

  async function bookInPersonEstimate(): Promise<void> {
    if (!voiceConsent || !leadPublicId) return;
    setBookingState("sending");
    setBookingError(null);
    try {
      // Mint a fresh reCAPTCHA v3 token bound to action "voice_consent".
      // This is a SEPARATE token from the one sent at lead-creation —
      // the server verifies action matches, so a replay of the lead-
      // creation token (action: "submit_lead") will be rejected.
      // No-ops gracefully to null in dev / preview; server fail-opens
      // in non-prod and hard-fails in prod (lib/recaptcha.ts).
      const recaptchaToken = await executeRecaptcha("voice_consent");
      const res = await fetch(
        `/api/leads/${encodeURIComponent(leadPublicId)}/voice-consent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Server controls the disclosure text — sending it from the
          // client would have been forgeable in the TCPA audit row.
          body: JSON.stringify({ consent: true, recaptchaToken }),
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

  // Retry lead-capture from the result screen. Fires when the initial
  // hero submit returned no publicId (network blip, server hiccup,
  // BotID false-positive). Surfaced as a single visible button in the
  // Rep CTA card instead of the prior dead-end "Refresh and resubmit"
  // hint. Reuses the form data stashed on the parent flow.
  const [leadRetryState, setLeadRetryState] = useState<"idle" | "sending" | "error">("idle");
  const [leadRetryError, setLeadRetryError] = useState<string | null>(null);
  const canRetryLead = !leadPublicId && pendingLeadCapture != null;
  async function retryLeadCapture(): Promise<void> {
    if (!pendingLeadCapture || leadRetryState === "sending") return;
    setLeadRetryState("sending");
    setLeadRetryError(null);
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: pendingLeadCapture.name,
          email: pendingLeadCapture.email,
          phone: pendingLeadCapture.phone,
          address: pendingLeadCapture.address,
          lat: pendingLeadCapture.lat,
          lng: pendingLeadCapture.lng,
          source: "estimate.nolandsroofing.com",
          office: pendingLeadCapture.officeSlug,
          marketingConsent: true,
          voiceConsent: false,
          // Preserve the EN/ES choice from the original hero submit.
          preferredLanguage: pendingLeadCapture.preferredLanguage ?? "en",
          // FUNNEL-2 — re-forward Places-derived city/state/zip on
          // retry so the JN contact gets the same address columns it
          // would have on a successful first submit.
          city: pendingLeadCapture.city,
          state: pendingLeadCapture.state,
          zip: pendingLeadCapture.zip,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Lead capture ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as { leadId?: string };
      if (typeof data.leadId !== "string") {
        throw new Error("Lead capture returned no ID");
      }
      onLeadRecaptured(data.leadId);
      setLeadRetryState("idle");
    } catch (err) {
      setLeadRetryError(err instanceof Error ? err.message : String(err));
      setLeadRetryState("error");
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

        {/* CRO HI-2 — result layout (post-tier-card-hoist):
              ┌─────────────────────────────────────┐
              │  Tier 1 │ Tier 2 (Most chosen) │ T3 │  full-width 3-col tier band
              ├──────────────────┬──────────────────┤
              │      Map         │     Storms       │  2-col equal-height row
              ├──────────────────┼──────────────────┤
              │     Parcel       │   (Rep CTA)      │  ← Rep CTA renders below
              └──────────────────┴──────────────────┘
            Tier prices were hoisted out of a quadrant because at 3 side-
            by-side cards they need the full row width to breathe (Decoy
            + Mimetic comparison shopping). Map dropped to a quadrant
            alongside Storms — still 1:1 aspect ratio per quadrant. */}

        {/* TIER BAND — full-width 3-col grid */}
        {tiers ? (
          <div className="mt-10 mx-auto" style={{ maxWidth: "1000px" }}>
            <div
              className="result-card"
              style={{ padding: "30px 20px 22px" }}
            >
              <span className="marker absolute -top-[3px] -left-[3px]" aria-hidden="true" />
              <span className="marker absolute -top-[3px] -right-[3px]" aria-hidden="true" />
              <span className="marker absolute -bottom-[3px] -left-[3px]" aria-hidden="true" />
              <span className="marker absolute -bottom-[3px] -right-[3px]" aria-hidden="true" />
              <div className="eyebrow mb-5 text-center">
                Four honest options for your roof
              </div>
              {/* Per-zip social proof from live JobNimbus data. Powered by
                  /api/social-proof/jobs-by-zip with the zip extracted from
                  the resolved formatted address. Only renders when count
                  ≥ 3 — smaller numbers feel fabricated rather than
                  reassuring. Mimetic desire is the highest-leverage
                  psychological lever at the pricing-decision moment. */}
              {zipJobCount !== null && zipJobCount >= 3 && (
                <div
                  style={{
                    textAlign: "center",
                    marginTop: "-8px",
                    marginBottom: "16px",
                    fontSize: "12px",
                    fontWeight: 500,
                    color: "var(--vx-muted)",
                    letterSpacing: "0.02em",
                  }}
                >
                  Noland&apos;s completed{" "}
                  <span
                    style={{
                      color: "var(--vx-terra)",
                      fontWeight: 700,
                    }}
                  >
                    {zipJobCount} roof project{zipJobCount === 1 ? "" : "s"}
                  </span>{" "}
                  in your zip code in the last year.
                </div>
              )}
              {/* Waste-factor transparency line — sits between the
                  social-proof line and the tier grid. Customer
                  knows up-front exactly how much material slack is
                  baked into the prices below, which removes a common
                  "why does this estimate seem high?" follow-up call.
                  Reads from the same API value the tier math uses, so
                  the displayed number always tracks the actual
                  calculation. Default 10% matches FLAT_CUSTOMER_WASTE_PERCENT. */}
              <div
                style={{
                  textAlign: "center",
                  marginTop: "4px",
                  marginBottom: "16px",
                  fontSize: "13px",
                  fontWeight: 500,
                  color: "var(--vx-ink-soft)",
                  letterSpacing: "0.01em",
                }}
              >
                Tier prices include{" "}
                <span
                  className="tabular"
                  style={{
                    color: "var(--color-noland-fire, var(--vx-terra))",
                    fontWeight: 700,
                  }}
                >
                  {result.pricing?.recommendedWastePercent ?? 10}%
                </span>{" "}
                material waste
              </div>
              <div
                className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 items-stretch"
                style={{ gap: "16px" }}
              >
                {tiers.map((t) => (
                  <TierCard
                    key={t.tier.id}
                    tier={t}
                    isOpen={openTierId === t.tier.id}
                    onToggle={() =>
                      setOpenTierId((current) =>
                        current === t.tier.id ? null : t.tier.id,
                      )
                    }
                  />
                ))}
              </div>

              {/* Heritage trust strip — CertainTeed (130 yrs) backed by
                  Saint-Gobain (360 yrs, one of the world's largest building-
                  materials manufacturers). Anchors the warranty claims
                  above. Verbatim trust language from Noland's printed
                  estimate form ("CertainTeed has been manufacturing
                  building products for well over 130 years and is backed
                  by Saint-Gobain, a company that has been in business for
                  over 360 years"). Heritage = depth of commitment. */}
              <div
                style={{
                  marginTop: "14px",
                  padding: "12px 16px",
                  border: "1px solid var(--vx-rule)",
                  borderRadius: "10px",
                  background: "rgba(199, 107, 63, 0.03)",
                  textAlign: "center",
                  fontSize: "12px",
                  lineHeight: 1.55,
                  color: "var(--vx-ink-soft)",
                  letterSpacing: "0.005em",
                }}
              >
                <span style={{ fontWeight: 600, color: "var(--vx-ink)" }}>
                  CertainTeed — 130+ years.{" "}
                </span>
                <span>
                  Backed by{" "}
                </span>
                <span style={{ fontWeight: 600, color: "var(--vx-ink)" }}>
                  Saint-Gobain
                </span>
                <span>
                  , a 360-year-old company and one of the largest
                  building-material manufacturers in the world. Every
                  warranty above carries that depth.
                </span>
              </div>
              {/* Honesty footnote — single line below all four tiers
                  instead of repeating "Confirmed at walkthrough" inside
                  each card. Pratfall: surface the financing math
                  transparently + admit the limitation ("we don't quote
                  sight-unseen") in the same breath. Higher trust, less
                  visual filler. */}
              <p
                style={{
                  marginTop: "18px",
                  textAlign: "center",
                  fontSize: "11px",
                  lineHeight: 1.5,
                  color: "var(--vx-muted)",
                  fontStyle: "italic",
                  maxWidth: "640px",
                  marginLeft: "auto",
                  marginRight: "auto",
                }}
              >
                Monthly estimates based on 15-year financing at 11.99% APR.
                Final price confirmed at on-site walkthrough — we don&apos;t
                quote sight-unseen.
              </p>
            </div>
          </div>
        ) : null}

        {/* 2×2 grid — map + storms (top), parcel + (empty/CTA hoist) below.
            Equal-height items keep the visual symmetry the original
            layout had. Empty quadrant is acceptable — Rep CTA renders
            full-width below so this row stays decorative/contextual. */}
        <div
          className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8 items-stretch w-full mx-auto"
          style={{ maxWidth: "1000px" }}
        >
          {/* TOP-LEFT — interactive map */}
          <div
            className="result-card overflow-hidden w-full"
            style={{ aspectRatio: "1 / 1" }}
          >
            <span className="marker absolute -top-[3px] -left-[3px]" aria-hidden="true" />
            <span className="marker absolute -top-[3px] -right-[3px]" aria-hidden="true" />
            <span className="marker absolute -bottom-[3px] -left-[3px]" aria-hidden="true" />
            <span className="marker absolute -bottom-[3px] -right-[3px]" aria-hidden="true" />
            <RoofMap
              centerLat={result.tile.centerLat}
              centerLng={result.tile.centerLng}
              zoom={result.tile.zoom}
              overlay={result.cyanOverlay ?? null}
              fallbackPngBase64={paintedImageBase64}
            />
          </div>

          {/* TOP-RIGHT — recent severe weather */}
          <StormsBlock storms={storms} loading={stormsLoading} />

          {/* BOTTOM-LEFT — property record (parcel data). */}
          <ParcelBlock
            parcel={parcel}
            storms={storms}
            visualRoofAssessment={visualRoofAssessment}
          />
        </div>

        {/* Wide Rep CTA — sits directly under the 2×2 grid as the
            page's primary action. Conversion-optimized ordering: the
            customer just finished scanning the measurement + tiers +
            storms + property record, so the next thing under their
            eye should be the booking action — not a wall of fine
            print. Disclosure band moves below the CTA. */}
        {/* CRO HI-4 — ref-wrapped RepCTACard so the sticky mobile bar
            can both observe its visibility AND scroll/focus into it on
            tap. The ref lives on the wrapping div (not the card
            internals) to avoid threading another prop through
            RepCTACard's signature. */}
        <div
          ref={repCtaRef}
          className="mt-6 mx-auto"
          style={{ maxWidth: "1000px" }}
        >
          <RepCTACard
            bookingState={bookingState}
            bookingError={bookingError}
            voiceConsent={voiceConsent}
            setVoiceConsent={setVoiceConsent}
            leadPublicId={leadPublicId}
            onBook={bookInPersonEstimate}
            canRetryLead={canRetryLead}
            leadRetryState={leadRetryState}
            leadRetryError={leadRetryError}
            onRetryLead={retryLeadCapture}
            recentLeadCount={recentLeadCount}
          />
        </div>

        {/* Full-width disclosure band — under the CTA so the fine print
            doesn't sit between the customer and the action. Combines:
            not-binding caveat + (conditional) tier-coverage explanation
            + material/waste basis + financing assumption. */}
        <DisclosureBand
          materialLabel={pricingMaterial.label}
          wastePercent={result.pricing?.recommendedWastePercent ?? 10}
          quotableSqft={result.solar.quotableSqft}
          displaySqft={sqft}
        />

        {/* Tertiary: re-pin link, ghost. */}
        <div className="mt-4 text-center">
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

        {/* Measurement chips. FACES E ("predominant compass") removed —
            not useful to the customer. Pitch chip ALSO removed — the
            per-facet pitch data from Solar API was unreliable on
            complex Florida roofs (8450 Oak Park showed a wrong
            low-slope split), and a single rolled-up pitch number is a
            measurement artifact the rep will verify on site anyway. */}
        <div className="mt-10 flex flex-wrap justify-center gap-3">
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

        {/* WhyNowCard removed from this position — parcel data now
            renders in the bottom-right quadrant of the 2×2 grid above
            (via the ParcelBlock component) so it visually balances the
            severe-weather block on its left. */}

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

      {/* CRO HI-4 — sticky mobile CTA bar. Renders only on viewports
          below md and only when the RepCTACard above is off-screen
          (intersection-observed via repCtaRef). Disabled once the
          customer has booked, so the bar disappears the moment the
          conversion event fires. */}
      <StickyMobileCTA
        targetRef={repCtaRef}
        enabled={bookingState !== "booked"}
      />
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

// ─── Parcel block (bottom-right of the above-the-fold grid) ────────────
//
// Replaces the prior position of the Rep CTA in the 2×2 grid. Shows
// FL DOR cadastral data — the credible "how old / how big / how much"
// signal that the satellite estimate can't answer on its own.
//
// Renders even when only some fields are populated (FL DOR commonly
// returns ACT_YR_BLT=0 with everything else populated). Falls back to
// a graceful "data unavailable" caption when truly nothing came back —
// avoids a blank quadrant that breaks the 2×2 visual rhythm. The
// caption also surfaces the actual reason so reps debugging from the
// rep workbench know whether to look it up manually.

/** Map Pro's enum primaryMaterial → plain-English label. Returns null
 *  for tokens that shouldn't surface to the customer (unknown / mixed
 *  → rep verifies). */
function describeMaterial(token: string): string | null {
  switch (token) {
    case "asphalt_3tab":
      return "3-tab asphalt shingle";
    case "asphalt_architectural":
      return "Architectural asphalt shingle";
    case "concrete_tile":
      return "Concrete tile";
    case "clay_tile":
      return "Clay tile";
    case "metal_standing_seam":
      return "Standing-seam metal";
    case "flat_membrane":
      return "Flat membrane (TPO/EPDM)";
    case "mixed":
    case "unknown":
    default:
      return null;
  }
}

/** Map Pro's enum conditionObservation → hedged customer copy.
 *
 *  LEGAL FRAMING — see `feedback_visual_condition_legal_framing` memory.
 *  Every line MUST read as a system detection ("appears", "possible",
 *  "what looks like"), never as a factual claim. The implication clause
 *  ("typically a sign of…") describes a general industry fact, which is
 *  safe; the observation clause is the part Pro could be wrong about
 *  and must therefore stay hedged.
 *
 *  Returns null for non-pain-point enums that would dilute the
 *  conversion goal (color_uniformity_good, tree_overhang_heavy,
 *  no_visible_issues). Those still live in the API response for the
 *  rep workbench. */
function describeObservation(token: string): string | null {
  switch (token) {
    case "dark_streaking":
      return "Possible algae streaking observed — typically associated with roofs 8+ years old.";
    case "granule_loss":
      return "Possible granule loss in patches — usually a sign the protective layer is wearing down.";
    case "missing_shingles":
      return "What looks like missing shingles in places — typically a leak-risk indicator.";
    case "patches_or_repairs":
      return "Prior patch repairs appear visible — partial fixes usually don't restore the original system warranty.";
    case "tarp_visible":
      return "What appears to be a tarp covering part of the roof — usually indicates active or recent damage.";
    case "ridge_damage":
      return "Possible damage along the ridge cap — a common water-intrusion path.";
    case "moss_or_vegetation":
      return "Possible moss or vegetation growth — typically traps moisture against the deck and accelerates wear.";
    case "color_uniformity_good":
    case "tree_overhang_heavy":
    case "no_visible_issues":
    default:
      return null;
  }
}

function ParcelBlock({
  parcel,
  storms,
  visualRoofAssessment,
}: {
  parcel: V3Response["parcel"];
  /** Storms data feeds the optional closing narrative paragraph. */
  storms: RecentStormsResponse | null;
  /** Hedged AI roof read — surfaces as a "Roof — what our imagery
   *  suggests" sub-section. Null when V3 dropped it (identity gate
   *  tripped, Pro failed, etc). */
  visualRoofAssessment: V3Response["visualRoofAssessment"];
}): React.ReactElement {
  const currentYear = new Date().getFullYear();
  const age =
    parcel && parcel.yearBuilt ? currentYear - parcel.yearBuilt : null;
  const effAge =
    parcel && parcel.effectiveYearBuilt && parcel.effectiveYearBuilt > 0
      ? currentYear - parcel.effectiveYearBuilt
      : null;
  const yearsOwned =
    parcel && parcel.lastSale
      ? currentYear - parcel.lastSale.year
      : null;
  const lotAcres =
    parcel && parcel.lotSqft && parcel.lotSqft >= 6_000
      ? parcel.lotSqft / 43_560
      : null;

  const hasAnyField =
    parcel != null &&
    (age != null ||
      effAge != null ||
      parcel.livingSqft != null ||
      lotAcres != null ||
      (parcel.justValue != null && parcel.justValue >= 50_000) ||
      parcel.lastSale != null ||
      (parcel.buildingCount != null && parcel.buildingCount > 1));

  return (
    <div
      className="result-card relative w-full flex flex-col"
      style={{ padding: "22px 20px" }}
    >
      <span className="marker absolute -top-[3px] -left-[3px]" aria-hidden="true" />
      <span className="marker absolute -top-[3px] -right-[3px]" aria-hidden="true" />
      <span className="marker absolute -bottom-[3px] -left-[3px]" aria-hidden="true" />
      <span className="marker absolute -bottom-[3px] -right-[3px]" aria-hidden="true" />

      {/* Title — serif terra, matches StormsBlock + RepCTACard titles. */}
      <div
        className="font-serif mb-4 text-center"
        style={{
          fontSize: "20px",
          fontWeight: 600,
          color: "var(--vx-terra)",
          letterSpacing: "-0.005em",
          lineHeight: 1.2,
        }}
      >
        Property record
      </div>

      {hasAnyField && parcel ? (
        <>
          <dl className="space-y-2">
            {age != null && (
              <WhyRow
                label="Year built"
                value={
                  <>
                    <span className="tabular">{parcel.yearBuilt}</span>
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
                    <span className="tabular">{parcel.effectiveYearBuilt}</span>
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
            {parcel.livingSqft != null && (
              <WhyRow
                label="Living area"
                value={
                  <span className="tabular">
                    {parcel.livingSqft.toLocaleString()} sqft
                  </span>
                }
              />
            )}
            {lotAcres != null && (
              <WhyRow
                label="Lot size"
                value={
                  <>
                    <span className="tabular">{lotAcres.toFixed(2)}</span>
                    <span
                      className="font-serif italic ml-1"
                      style={{ color: "var(--vx-ink-soft)" }}
                    >
                      acres
                    </span>
                  </>
                }
              />
            )}
            {parcel.justValue != null && parcel.justValue >= 50_000 && (
              <WhyRow
                label="County assessed"
                value={
                  <span className="tabular">
                    ${(parcel.justValue / 1000).toLocaleString(undefined, {
                      maximumFractionDigits: 0,
                    })}
                    k
                  </span>
                }
              />
            )}
            {parcel.buildingCount != null && parcel.buildingCount > 1 && (
              <WhyRow
                label="Buildings on lot"
                value={
                  <>
                    <span className="tabular">{parcel.buildingCount}</span>
                    <span
                      className="font-serif italic ml-2"
                      style={{ color: "var(--vx-ink-soft)" }}
                    >
                      main + accessory
                    </span>
                  </>
                }
              />
            )}
            {parcel.lastSale && yearsOwned != null && (
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
          <RoofConditionSection assessment={visualRoofAssessment} />
          <div
            className="mt-3 font-serif italic text-center"
            style={{ fontSize: "11px", color: "var(--vx-muted)" }}
          >
            Source: Florida Dept. of Revenue cadastral
            {parcel.assessmentYear ? `, ${parcel.assessmentYear} roll` : ""}.
          </div>
        </>
      ) : (
        // Graceful empty state. flex-1 + justify-center makes this
        // section grow to fill whatever vertical space the storms block
        // (sibling on the left) is taking up, with the content centered
        // — no dead pocket at the bottom of the card.
        //
        // Copy reframed away from "we failed to fetch X" toward what
        // the rep WILL do on-site, so the empty state still adds value
        // for the customer instead of reading as a missing-data
        // apology.
        <div
          className="flex-1 flex flex-col justify-center text-center"
          style={{ fontSize: "13px", lineHeight: 1.55 }}
        >
          {hasDisplayableRoofAssessment(visualRoofAssessment) ? (
            // Visual roof read substitutes for the rep-verifies copy —
            // it already includes the "confirmed on-site by your rep"
            // footer, so duplicating the original empty-state paragraphs
            // would double the message AND stretch the card past
            // square in the 2×2 grid.
            <RoofConditionSection assessment={visualRoofAssessment} />
          ) : (
            <>
              <p
                className="font-serif"
                style={{
                  fontSize: "14px",
                  color: "var(--vx-ink)",
                  fontStyle: "italic",
                }}
              >
                Property age + lot details get verified by the roofer
                on site.
              </p>
              <p
                className="mt-2 mx-auto"
                style={{
                  fontSize: "12px",
                  color: "var(--vx-ink-soft)",
                  maxWidth: "34ch",
                }}
              >
                County records vary by parcel and aren&apos;t always
                visible from satellite alone — your rep will pull
                year-built, living area, and the most recent sale
                during the 20-minute walkthrough.
              </p>
            </>
          )}
        </div>
      )}

      {/* Italic narrative closer — only renders when we actually have
          something to say (parcel facts OR storm context). */}
      {(hasAnyField || (storms && storms.summary.total > 0)) &&
        (() => {
          const closer = buildWhyNowNarrative({
            age,
            effAge,
            yearsOwned,
            storms: storms?.summary ?? null,
          });
          if (!closer) return null;
          return (
            <div
              className="mt-4 pt-3 font-serif italic text-center"
              style={{
                fontSize: "13px",
                lineHeight: 1.5,
                color: "var(--vx-ink)",
                borderTop: "1px solid var(--vx-rule)",
              }}
            >
              {closer}
            </div>
          );
        })()}
    </div>
  );
}

// ─── Rep CTA card (bottom-right of the above-the-fold grid) ────────────
//
// Repositioned from a stacked card under the tier prices to its own
// quadrant beside the storms block, matching the storms block's height.
// Copy rewritten to lead with value ("Lock in your real number") rather
// than commitment ("Want a rep at your door?") — homeowners just saw a
// price they didn't ask for, so framing the CTA as VERIFICATION instead
// of a sales call is the right entrance.

type BookingState = "idle" | "sending" | "booked" | "error";

// ─── Booked success card (CRO P1.3) ───────────────────────────────────
//
// Replaces the prior one-paragraph "You're on the list" message with a
// real reassurance block. After the customer commits to a voice
// callback from an AI, four anxieties spike: (1) "when exactly will
// she call", (2) "what if it shows up as Spam Likely on my phone",
// (3) "what is she going to ask me", (4) "what if I don't want to
// answer right now."
//
// This card addresses all four:
//   - Live countdown that ticks down from 10s, then sits on "Sydney
//     is calling now…" (purely visual — the actual dispatch fired
//     server-side the moment booking succeeded; Sarah's LK+Twilio
//     SIP leg typically connects in 5-10s).
//   - Tap-to-call line that pre-populates Sydney's caller-ID
//     (321-985-1104) so the customer can save it to contacts and
//     avoid the Spam-Likely screening that kills outbound conversion.
//   - "What she'll ask" preview — three short lines so the customer
//     mentally rehearses the call and is less likely to ghost it.
//   - Optional SMS-instead fallback for customers who decide they'd
//     rather not talk live.

function BookedSuccessCard(): React.ReactElement {
  // Countdown clock from 10 → 0. Sydney's outbound dispatch typically
  // connects in 5-10 seconds (LK Cloud + Twilio SIP cold start), and
  // the homeowner-facing copy promises a 10-second callback. Keeps the
  // clock honest — a 30s clock that finishes BEFORE Sarah dials makes
  // the page feel broken, but a 10s clock ending right as the phone
  // rings makes the system feel real-time.
  const [secondsLeft, setSecondsLeft] = useState(10);
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft]);
  const calling = secondsLeft <= 0;

  return (
    <div
      className="result-card relative"
      style={{
        padding: "28px 24px",
        borderColor: "var(--vx-terra)",
        borderWidth: "2px",
      }}
    >
      <span className="marker absolute -top-[3px] -left-[3px]" aria-hidden="true" />
      <span className="marker absolute -top-[3px] -right-[3px]" aria-hidden="true" />
      <span className="marker absolute -bottom-[3px] -left-[3px]" aria-hidden="true" />
      <span className="marker absolute -bottom-[3px] -right-[3px]" aria-hidden="true" />

      <div className="mx-auto" style={{ maxWidth: "520px" }}>
        {/* Title — same serif terra anchor the CTA card used; visual
            continuity from "Lock in your real number" → "You're locked in". */}
        <div
          className="font-serif mb-2 text-center"
          style={{
            fontSize: "22px",
            fontWeight: 600,
            color: "var(--vx-terra)",
            letterSpacing: "-0.005em",
            lineHeight: 1.2,
          }}
        >
          You&apos;re locked in
        </div>

        {/* Live countdown — the concrete wait timer. Once it hits 0,
            swap to a calmer "Sydney is calling now" so we don't pin
            the user to a stale clock if the call connects later. */}
        <div
          className="text-center mb-5"
          style={{
            fontSize: "14px",
            lineHeight: 1.5,
            color: "var(--vx-ink)",
          }}
        >
          {calling ? (
            <span>
              <span style={{ fontWeight: 600 }}>
                {AGENT_DISPLAY_NAME} is calling now
              </span>
              {" — please answer."}
            </span>
          ) : (
            <span>
              {AGENT_DISPLAY_NAME} will call in{" "}
              <span
                className="tabular"
                style={{ fontWeight: 700, color: "var(--vx-terra)" }}
              >
                {secondsLeft}s
              </span>
              .
            </span>
          )}
        </div>

        {/* Save-the-number callout — the actual conversion-killer fix.
            Florida households screen unknown numbers aggressively; if
            Sydney's caller-ID isn't in the contacts list, the call
            often goes straight to voicemail. The tap-to-call link
            opens the dialer (iOS + Android), which is the cheapest
            "add to contacts" affordance available cross-platform. */}
        <div
          style={{
            background: "rgba(199, 107, 63, 0.08)",
            border: "1px solid var(--vx-terra)",
            borderRadius: "10px",
            padding: "12px 14px",
            marginBottom: "16px",
          }}
        >
          <div
            className="text-center"
            style={{
              fontSize: "12.5px",
              color: "var(--vx-ink)",
              lineHeight: 1.5,
            }}
          >
            {AGENT_DISPLAY_NAME} calls from{" "}
            <a
              href={`tel:${AGENT_CALLER_ID_E164}`}
              style={{
                color: "var(--vx-terra)",
                fontWeight: 700,
                textDecoration: "none",
                borderBottom: "1px solid var(--vx-terra)",
              }}
            >
              {AGENT_CALLER_ID_FORMATTED}
            </a>
            . Tap to save it so it doesn&apos;t show as Spam Likely.
          </div>
        </div>

        {/* Sydney call preview — 3 lines so the customer mentally
            rehearses the call. Reduces "I don't know what she'll
            ask me, I'll just ignore the call" ghosting behavior. */}
        <div
          className="text-center mb-4"
          style={{
            fontSize: "12.5px",
            color: "var(--vx-ink-soft)",
            lineHeight: 1.55,
          }}
        >
          <div
            className="eyebrow mb-2"
            style={{ color: "var(--vx-ink-soft)" }}
          >
            She&apos;ll ask three quick things
          </div>
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "inline-block",
              textAlign: "left",
            }}
          >
            <li style={{ marginBottom: "4px" }}>
              <span style={{ color: "var(--vx-terra)", fontWeight: 700, marginRight: "8px" }}>
                ·
              </span>
              When works for you to have a roofer stop by
            </li>
            <li style={{ marginBottom: "4px" }}>
              <span style={{ color: "var(--vx-terra)", fontWeight: 700, marginRight: "8px" }}>
                ·
              </span>
              Any concerns or recent leaks
            </li>
            <li>
              <span style={{ color: "var(--vx-terra)", fontWeight: 700, marginRight: "8px" }}>
                ·
              </span>
              Confirm your address and door access
            </li>
          </ul>
        </div>

        {/* SMS fallback — for customers who change their mind about
            taking a live call. We can't programmatically cancel
            the dispatch from the client (it already fired), but we
            can offer a low-friction alternate path: text her the
            details, she'll pick it up on the next pass. The
            sms:?body= prefill lands in the system message composer
            on iOS + Android with the body ready to edit. */}
        <div className="text-center">
          <a
            href={`sms:${AGENT_CALLER_ID_E164}?body=Can%20we%20message%20instead%20of%20talking%3F`}
            style={{
              fontSize: "12px",
              letterSpacing: "0.04em",
              color: "var(--vx-muted)",
              textDecoration: "none",
              borderBottom: "1px dashed var(--vx-muted)",
              padding: "2px 0",
            }}
          >
            Prefer to text instead? Message {AGENT_DISPLAY_NAME}
          </a>
        </div>
      </div>
    </div>
  );
}

function RepCTACard({
  bookingState,
  bookingError,
  voiceConsent,
  setVoiceConsent,
  leadPublicId,
  onBook,
  canRetryLead,
  leadRetryState,
  leadRetryError,
  onRetryLead,
  recentLeadCount,
}: {
  bookingState: BookingState;
  bookingError: string | null;
  voiceConsent: boolean;
  setVoiceConsent: (v: boolean) => void;
  leadPublicId: string | null;
  onBook: () => void;
  /** True when leadPublicId is null AND we have stashed form data we
   *  can re-POST. Triggers the visible "Reconnect" button instead of
   *  the prior dead-end "Refresh and resubmit" hint. */
  canRetryLead: boolean;
  leadRetryState: "idle" | "sending" | "error";
  leadRetryError: string | null;
  onRetryLead: () => void;
  /** Rolling 7-day Noland's lead count from /api/leads/recent-count.
   *  Null while fetching or when the endpoint soft-fails. The card
   *  only renders social proof when this is ≥5 — small numbers feel
   *  fabricated and undermine the Pratfall trust voice. */
  recentLeadCount: number | null;
}): React.ReactElement {
  if (bookingState === "booked") {
    return <BookedSuccessCard />;
  }

  return (
    <div
      className="result-card relative"
      style={{ padding: "28px 24px" }}
    >
      <span className="marker absolute -top-[3px] -left-[3px]" aria-hidden="true" />
      <span className="marker absolute -top-[3px] -right-[3px]" aria-hidden="true" />
      <span className="marker absolute -bottom-[3px] -left-[3px]" aria-hidden="true" />
      <span className="marker absolute -bottom-[3px] -right-[3px]" aria-hidden="true" />

      {/* Center the content inside the wide card with a max-width so the
          copy + consent + button stay readable on wide screens (the card
          itself spans the full disclosure-band width). */}
      <div className="mx-auto" style={{ maxWidth: "560px" }}>
        {/* Title — serif terra, matches the StormsBlock title for symmetry. */}
        <div
          className="font-serif mb-3 text-center"
          style={{
            fontSize: "22px",
            fontWeight: 600,
            color: "var(--vx-terra)",
            letterSpacing: "-0.005em",
            lineHeight: 1.2,
          }}
        >
          Lock in your real number
        </div>

        {/* Body — lead with value, end with friction-reducer. */}
        <p
          className="text-center mb-4"
          style={{
            fontSize: "14px",
            lineHeight: 1.5,
            color: "var(--vx-ink)",
          }}
        >
          A licensed roofer walks your property — exact sqft, decking
          condition, code work — and puts a{" "}
          <span style={{ fontWeight: 600 }}>written quote</span> in your hand.{" "}
          <span className="font-serif italic" style={{ color: "var(--vx-ink-soft)" }}>
            Free, about 20 minutes, no obligation.
          </span>
        </p>

        {/* CRO QW-3 — real urgency line. FL storm season is genuinely
            booking out 2-3 weeks (same fact the B4_T7D_STORM_ANCHOR
            abandoner reminder uses). NOT manufactured scarcity. Sits
            above the consent so it reframes the booking decision from
            "I'll do this later" to "I should grab a slot now." */}
        <div
          className="text-center mb-3"
          style={{
            fontSize: "12px",
            fontWeight: 600,
            letterSpacing: "0.04em",
            color: "var(--vx-terra)",
          }}
        >
          Booking available immediately in your area.
        </div>

        {/* CRO QW-2 — real local social proof at the conversion moment.
            Count fetched from /api/leads/recent-count (7-day rolling,
            cached 15 min). Only renders when count is meaningful (≥5)
            so we never fake the proof — Pratfall brand voice forbids
            it. Falls back to a generic Mere-Exposure line when count
            is too small. */}
        {typeof recentLeadCount === "number" && recentLeadCount >= 5 && (
          <div
            className="text-center mb-3 font-serif italic"
            style={{
              fontSize: "12.5px",
              color: "var(--vx-ink-soft)",
              lineHeight: 1.4,
            }}
          >
            Joined by {recentLeadCount} Florida homeowners this week.
          </div>
        )}

        {/* TCPA-compliant consent — kept concise. */}
        <label
          className="flex items-start gap-3 cursor-pointer mb-4 mx-auto"
          style={{
            fontSize: "12.5px",
            color: "var(--vx-ink-soft)",
            lineHeight: 1.5,
            maxWidth: "480px",
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
            {/* FCC Feb 2024 ruling: AI/synthetic voice = "artificial
                voice" under the TCPA. Disclosure has to be at consent
                time, not buried in the call. "AI voice assistant" is
                the visible label that matches the server-side audit-row
                text in `lib/tcpa-consent.ts`. */}
            Yes, call me with an AI voice assistant to schedule. I can
            hang up, say &ldquo;remove me,&rdquo; or reply STOP anytime.
          </span>
        </label>

        <div>
        <button
          type="button"
          className="btn-terra w-full"
          style={{
            fontSize: "15px",
            fontWeight: 700,
            letterSpacing: "0.02em",
            padding: "14px 18px",
          }}
          disabled={
            !voiceConsent ||
            !leadPublicId ||
            bookingState === "sending"
          }
          onClick={onBook}
        >
          {bookingState === "sending" ? "Booking…" : "Lock in my real number"}
          <span className="arrow" aria-hidden="true">→</span>
        </button>

        {/* CRO QW-1 — disabled-button affordance. Without this hint
            the disabled state reads as a broken site; the customer
            doesn't know the consent checkbox is gating the action.
            Only renders when the gate is the consent (not the lead-
            retry / loading paths, which surface their own copy). */}
        {!voiceConsent && leadPublicId && bookingState !== "sending" && (
          <div
            className="mt-2 text-center"
            style={{
              fontSize: "11.5px",
              color: "var(--vx-muted)",
              fontStyle: "italic",
            }}
          >
            Check the box above to enable.
          </div>
        )}

        {/* Trust line — quick reassurance scan: free, in writing,
            customer-controlled. Sits directly under the button so it
            reads as a continuation of "what happens when I click." */}
        <div
          className="mt-3 text-center font-serif italic"
          style={{
            fontSize: "12px",
            lineHeight: 1.45,
            color: "var(--vx-ink-soft)",
          }}
        >
          Free measurement · Written quote · Your decision
        </div>

        {/* CRO QW-4 — phone escape hatch. Customers in "talk to a
            human now" mode have nowhere to go on the current result
            page; this gives them a low-friction tap-to-call. Tradeoff:
            we lose some Sydney funnel volume, but inbound calls
            convert at a much higher rate than outbound voice consent,
            so net is positive. tel: link on mobile triggers the
            dialer; on desktop most browsers show a copy-able number. */}
        <div
          className="mt-2 text-center"
          style={{
            fontSize: "12px",
            color: "var(--vx-ink-soft)",
            lineHeight: 1.45,
          }}
        >
          Prefer to talk?{" "}
          <a
            href={`tel:${MAIN_PHONE_E164}`}
            style={{
              color: "var(--vx-terra)",
              fontWeight: 600,
              textDecoration: "none",
              borderBottom: "1px solid var(--vx-terra)",
            }}
          >
            {MAIN_PHONE_FORMATTED}
          </a>
        </div>

        {!leadPublicId && canRetryLead && (
          <div className="mt-3 text-center">
            <button
              type="button"
              onClick={onRetryLead}
              disabled={leadRetryState === "sending"}
              style={{
                fontSize: "12px",
                fontWeight: 600,
                letterSpacing: "0.02em",
                color: "var(--vx-terra)",
                background: "none",
                border: `1px solid var(--vx-terra)`,
                borderRadius: "6px",
                padding: "8px 14px",
                cursor: leadRetryState === "sending" ? "wait" : "pointer",
              }}
            >
              {leadRetryState === "sending"
                ? "Reconnecting…"
                : "Reconnect to enable booking"}
            </button>
            {leadRetryState === "error" && leadRetryError && (
              <p
                className="mt-2"
                style={{ fontSize: "11px", color: "#8a2c2c" }}
              >
                {leadRetryError}
              </p>
            )}
          </div>
        )}
        {!leadPublicId && !canRetryLead && (
          <p
            className="mt-2 text-center"
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
          <p className="mt-2 text-center" style={{ fontSize: "11px", color: "#8a2c2c" }}>
            {bookingError}
          </p>
        )}
        </div>
      </div>
    </div>
  );
}

// ─── Sticky mobile CTA bar (CRO HI-4) ─────────────────────────────────
//
// Floating bottom-of-viewport CTA shown only on mobile. The
// result-page scroll path is long (tier band → map → storms → parcel
// → RepCTACard) and on phones the customer can finger-scroll for
// many seconds before reaching the conversion action — long enough
// to forget the action was there. The sticky bar keeps the CTA
// always-tap-able while never covering content (auto-hides when the
// RepCTACard is in view via IntersectionObserver).
//
// Why a separate component:
//   - Tightly scoped behavior + ref-based intersection observation
//   - md:hidden — desktop renders the wide RepCTACard directly, no
//     sticky overlay needed (the desktop fold easily fits the CTA)
//   - safe-area-inset-bottom respects iPhone home-indicator clearance
//
// What it does NOT do:
//   - Never auto-checks the voice consent — compliance demands an
//     affirmative customer action on that checkbox. Tap on this bar
//     just scrolls + focuses the consent for the customer to tick.

function StickyMobileCTA({
  targetRef,
  enabled,
}: {
  /** Ref to the RepCTACard wrapper. Used both for intersection
   *  observation (hide when in view) and as the scrollIntoView
   *  target when the customer taps the sticky bar. */
  targetRef: React.RefObject<HTMLDivElement | null>;
  /** Parent passes false to fully unmount the bar — e.g. when the
   *  booking has succeeded ("You're on the list") and the bar would
   *  be confusing. */
  enabled: boolean;
}): React.ReactElement | null {
  const [visible, setVisible] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    if (!enabled) return;
    const target = targetRef.current;
    if (!target) return;
    // The bar should be VISIBLE when the RepCTACard is OFF-screen.
    // rootMargin negative-bottom lets us hide the bar slightly
    // before the CTA enters the viewport, avoiding a "flash" the
    // moment the customer scrolls to the CTA naturally.
    const obs = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        setVisible(!entry.isIntersecting);
      },
      { rootMargin: "0px 0px -25% 0px", threshold: 0 },
    );
    obs.observe(target);
    return () => obs.disconnect();
  }, [targetRef, enabled]);

  const onTap = () => {
    const target = targetRef.current;
    if (!target) return;
    // Smooth scroll keeps the spatial connection between the bar
    // and the CTA — customer's eye follows the motion to the
    // checkbox they then need to tap.
    target.scrollIntoView({
      behavior: prefersReducedMotion ? "auto" : "smooth",
      block: "center",
    });
    // Best-effort focus on the consent checkbox once the scroll
    // settles. Wrapped in a timeout that matches a typical smooth
    // scroll duration. Failing silently is fine — the visual scroll
    // already accomplishes the main job.
    setTimeout(
      () => {
        const checkbox = target.querySelector<HTMLInputElement>(
          'input[type="checkbox"]',
        );
        checkbox?.focus({ preventScroll: true });
      },
      prefersReducedMotion ? 0 : 380,
    );
  };

  if (!enabled) return null;

  const transition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: 0.25, ease: [0.4, 0, 0.2, 1] as const };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="sticky-cta"
          className="md:hidden"
          initial={{ y: "110%", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "110%", opacity: 0 }}
          transition={transition}
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 50,
            // Backdrop blur over the page — keeps the bar legible no
            // matter what's underneath without fully blocking the
            // content peek.
            background:
              "color-mix(in srgb, var(--vx-cream, #faf7f0) 92%, transparent)",
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
            borderTop: "1px solid var(--vx-rule)",
            // env(safe-area-inset-bottom) clears the iPhone home
            // indicator. Falls back to 12px on devices without one.
            padding:
              "12px 16px calc(12px + env(safe-area-inset-bottom)) 16px",
            // Subtle shadow above the bar separates it from page
            // content underneath without competing with the CTA button.
            boxShadow: "0 -8px 24px rgba(0, 0, 0, 0.08)",
          }}
          // ARIA: announce as a complementary landmark so screen
          // reader users discover the persistent action.
          role="complementary"
          aria-label="Quick booking action"
        >
          <button
            type="button"
            onClick={onTap}
            className="btn-terra w-full"
            style={{
              fontSize: "15px",
              fontWeight: 700,
              letterSpacing: "0.02em",
              padding: "14px 18px",
              // Full-width inside the padded container.
              width: "100%",
              justifyContent: "center",
            }}
          >
            Lock in my real number
            <span className="arrow" aria-hidden="true">↓</span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─── Disclosure band (full-width fine print under the grid) ─────────────
//
// Consolidates four pieces of fine print that used to live inside the
// tier-price card on the right column:
//
//   1. "Not a final or binding quote" caveat
//   2. (conditional) tier-coverage explanation when display sqft >
//      quotable sqft (i.e. low-slope addition present)
//   3. Material + waste basis
//   4. Financing assumption
//
// Pulling them out of the price card lets the tiers stand cleanly on
// their own and keeps related disclosures grouped in one place.

function DisclosureBand({
  materialLabel,
  wastePercent,
  quotableSqft,
  displaySqft,
}: {
  materialLabel: string;
  wastePercent: number;
  /** @deprecated kept for back-compat; ignored at the customer
   *  surface. Rep dashboard still reads it. */
  quotableSqft: number | null;
  displaySqft: number | null;
}): React.ReactElement {
  // Customer view always reports the full headline sqft. The
  // satellite-derived "shingled vs flat" split was unreliable on
  // complex Florida roofs (8450 Oak Park) and confused homeowners
  // who saw a sqft on the page that didn't match the tier-price
  // breakdown.
  void quotableSqft; // silence the unused warning; field intentionally retained
  return (
    <div
      className="mt-8 mx-auto"
      style={{
        maxWidth: "1000px",
        padding: "18px 24px",
        borderTop: "1px solid var(--vx-rule)",
        borderBottom: "1px solid var(--vx-rule)",
        background: "rgba(15, 27, 45, 0.015)",
      }}
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-8 text-center">
        {/* Cell 1 — Not a final quote */}
        <div style={{ fontSize: "12px", lineHeight: 1.55, color: "var(--vx-ink-soft)" }}>
          <span style={{ color: "var(--vx-ink)", fontWeight: 700 }}>
            Not a final or binding quote.
          </span>{" "}
          Quick visual estimate from satellite imagery. Final price
          depends on what we find on site (decking condition, layers,
          code work). Confirmed by a licensed roofer.
        </div>

        {/* Cell 2 — Tier coverage. Always reports the full headline
            sqft; flat-section adjustments are a rep-side concern, not
            a customer-page split. */}
        <div style={{ fontSize: "12px", lineHeight: 1.55, color: "var(--vx-ink-soft)" }}>
          Tier prices above cover the full{" "}
          {displaySqft != null && (
            <>
              <span className="tabular" style={{ color: "var(--vx-ink)", fontWeight: 600 }}>
                {displaySqft.toLocaleString()}
              </span>{" "}
            </>
          )}
          sqft, priced as{" "}
          <span style={{ color: "var(--vx-ink)", fontWeight: 600 }}>
            {materialLabel.toLowerCase()}
          </span>{" "}
          with{" "}
          <span className="tabular" style={{ color: "var(--vx-ink)", fontWeight: 600 }}>
            {wastePercent}%
          </span>{" "}
          waste assumed. Any flat-roof sections are adjusted on site.
        </div>

        {/* Cell 3 — Financing assumption */}
        <div style={{ fontSize: "12px", lineHeight: 1.55, color: "var(--vx-ink-soft)" }}>
          <span style={{ color: "var(--vx-ink)", fontWeight: 600 }}>
            Monthly est. assumes 15-year financing at 11.99% APR.
          </span>{" "}
          Actual terms depend on credit + your finance partner.
        </div>
      </div>
    </div>
  );
}

// ─── Severe weather block (renders under the satellite map) ─────────────
//
// Extracted from WhyNowCard's right column so the above-the-fold layout
// stays balanced — left side gets map + storms, right side gets the
// tier price card. Hides itself when there's nothing meaningful to show
// (no storms found AND we're not still waiting on the NWS fetch).

function StormsBlock({
  storms,
  loading,
}: {
  storms: RecentStormsResponse | null;
  loading: boolean;
}) {
  const hasStorms = storms != null && storms.summary.total > 0;
  if (!hasStorms && !loading) return null;

  const sortedEvents = (storms?.events ?? [])
    .slice()
    .sort((a, b) => (b.magnitude ?? 0) - (a.magnitude ?? 0))
    .slice(0, 3);

  return (
    <div className="result-card relative w-full" style={{ padding: "22px 20px" }}>
      <span className="marker absolute -top-[3px] -left-[3px]" aria-hidden="true" />
      <span className="marker absolute -top-[3px] -right-[3px]" aria-hidden="true" />
      <span className="marker absolute -bottom-[3px] -left-[3px]" aria-hidden="true" />
      <span className="marker absolute -bottom-[3px] -right-[3px]" aria-hidden="true" />
      <div
        className="font-serif mb-4 text-center"
        style={{
          fontSize: "20px",
          fontWeight: 600,
          color: "var(--vx-terra)",
          letterSpacing: "-0.005em",
          lineHeight: 1.2,
        }}
      >
        Severe weather, last 12 months
      </div>

      {loading && !hasStorms ? (
        <div aria-busy="true" aria-label="Loading recent severe weather">
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
        </div>
      ) : hasStorms ? (
        <>
          <dl className="space-y-2">
            <WhyRow
              label="Events within 25 mi"
              value={<span className="tabular">{storms!.summary.total}</span>}
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
                  <span className="tabular">{storms!.summary.tornadoCount}</span>
                }
              />
            )}
          </dl>

          {sortedEvents.length > 0 && (
            <ul
              className="mt-3 space-y-1"
              style={{ fontSize: "12px", color: "var(--vx-ink-soft)" }}
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
            className="mt-3 font-serif italic text-center"
            style={{ fontSize: "11px", color: "var(--vx-muted)" }}
          >
            Source: NWS Local Storm Reports via Iowa Environmental Mesonet.
          </div>

          {/* Storm-context closer (was previously rendered inside the
              Property Record card, which read like a layout bug — moved
              here so the hail / wind narrative lives WITH the data it
              describes). */}
          {(() => {
            const stormCloser = buildStormNarrative(storms?.summary ?? null);
            if (!stormCloser) return null;
            return (
              <div
                className="mt-4 pt-3 font-serif italic text-center"
                style={{
                  fontSize: "13px",
                  lineHeight: 1.5,
                  color: "var(--vx-ink)",
                  borderTop: "1px solid var(--vx-rule)",
                }}
              >
                {stormCloser}
              </div>
            );
          })()}
        </>
      ) : null}
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

/** Apply the same filters RoofConditionSection uses internally, so
 *  callers can decide whether to suppress nearby duplicate copy (e.g.
 *  the empty-state rep-verifies paragraph) without re-implementing
 *  the gating logic. */
function hasDisplayableRoofAssessment(
  assessment: V3Response["visualRoofAssessment"],
): boolean {
  if (!assessment) return false;
  const hasMaterial = describeMaterial(assessment.primaryMaterial) != null;
  if (assessment.confidence === "low") return hasMaterial;
  const hasObs = assessment.conditionObservations.some(
    (t) => describeObservation(t) != null,
  );
  return hasMaterial || hasObs;
}

/**
 * Customer-facing roof condition read from the V3 visual assessment.
 *
 * LEGAL FRAMING — see `feedback_visual_condition_legal_framing` memory.
 * Renders Gemini Pro's output as a SYSTEM DETECTION, never as fact:
 *   - "Likely material" label hedges by itself (matches WhyRow style
 *     of the existing parcel rows, so it slots in visually)
 *   - Each observation carries its own hedge in describeObservation()
 *   - Footer defers ground truth to the rep on-site
 *
 * Visual goals (post-2026-05 design review):
 *   - Compact enough that adding it doesn't stretch the 2×2 grid
 *     bottom row beyond square. One label/value row + bullets +
 *     one italic source line.
 *   - Typography matches the existing parcel rows + cadastral footer
 *     exactly — `WhyRow` for material, same italic 11px muted footer
 *     style as "Source: FDOR cadastral".
 *
 * Gates (also encoded in `hasDisplayableRoofAssessment`):
 *   - Null assessment → null render
 *   - `confidence: "low"` suppresses observations entirely (still
 *     shows material if known — don't hand a customer pain points
 *     the model flagged as uncertain)
 *   - Non-pain-point enums (color_uniformity_good, tree_overhang_heavy,
 *     no_visible_issues) drop here — they stay in the API response
 *     for the rep workbench but undermine conversion in the customer
 *     surface
 *   - Material unknown/mixed → no material line (rep verifies)
 *   - Nothing-to-show → null render
 */
function RoofConditionSection({
  assessment,
}: {
  assessment: V3Response["visualRoofAssessment"];
}): React.ReactElement | null {
  if (!assessment) return null;

  const materialLabel = describeMaterial(assessment.primaryMaterial);
  const lowConfidence = assessment.confidence === "low";
  // Cap at 2 observations for the customer surface. Two pain points
  // is enough to motivate a rep walkthrough; more turns the box into
  // a bulleted laundry list and stretches the 2×2 grid past square.
  // The rep workbench still gets the full list from the API response.
  const CUSTOMER_OBSERVATION_CAP = 2;
  const observationLines = lowConfidence
    ? []
    : assessment.conditionObservations
        .map(describeObservation)
        .filter((line): line is string => line != null)
        .slice(0, CUSTOMER_OBSERVATION_CAP);

  if (!materialLabel && observationLines.length === 0) return null;

  // Format the Street View pano date as "Mar 2024" when present —
  // anchors the read in a real photo the customer could verify.
  let streetViewDateLabel: string | null = null;
  if (assessment.streetViewVerified && assessment.streetViewDate) {
    const d = new Date(assessment.streetViewDate);
    if (!Number.isNaN(d.getTime())) {
      streetViewDateLabel = d.toLocaleDateString(undefined, {
        month: "short",
        year: "numeric",
      });
    }
  }

  return (
    <div
      className="mt-3 pt-3"
      style={{ borderTop: "1px solid rgba(0,0,0,0.08)" }}
    >
      {materialLabel && (
        <dl className="space-y-2">
          <WhyRow label="Likely material" value={materialLabel} />
        </dl>
      )}
      {observationLines.length > 0 && (
        <ul
          style={{
            margin: materialLabel ? "8px 0 0" : "0",
            paddingLeft: 14,
            fontSize: "12px",
            color: "var(--vx-ink-soft)",
            lineHeight: 1.45,
            listStyle: "disc",
          }}
        >
          {observationLines.map((line, idx) => (
            <li key={idx} style={{ marginBottom: 2 }}>
              {line}
            </li>
          ))}
        </ul>
      )}
      <div
        className="mt-2 font-serif italic text-center"
        style={{ fontSize: "11px", color: "var(--vx-muted)" }}
      >
        Computer-vision read from satellite
        {streetViewDateLabel ? ` + ${streetViewDateLabel} street photo` : ""} ·
        confirmed on-site by your rep.
      </div>
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
/**
 * Storm-context closer — renders at the bottom of the Severe Weather
 * card. Split out of the original `buildWhyNowNarrative` so the hail /
 * wind copy actually appears INSIDE the severe-weather block, not the
 * property-record block (which is what was happening before — visually
 * confusing because the closer was about storms but lived under
 * "Property record"). Returns null when there's nothing storm-y enough
 * to warrant a callout. */
function buildStormNarrative(
  storms: RecentStormsResponse["summary"] | null,
): string | null {
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
  return null;
}

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
  // Storm branches (1 + 2) have moved to buildStormNarrative + render
  // inside the Severe Weather card. This function now only returns
  // property-record-side closers (age + mixed age/storm).

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
// ─── Good / Better / Best tier card (HI-2 side-by-side) ───────────────
//
// Replaces the prior `TierRow` vertical-stack accordion. The accordion
// hid features behind 3 separate clicks, breaking the Decoy + Mimetic
// psychology that drives Good/Better/Best comparison shopping. New
// card surfaces the top 4 features inline so the customer can compare
// at a glance. Expand-on-click stays for the full feature list +
// warranty fine print.

function TierCard({
  tier,
  isOpen,
  onToggle,
}: {
  tier: TierPrice;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const isPrimary = tier.tier.accent === "primary";
  const accentColor =
    tier.tier.accent === "premium"
      ? "var(--vx-terra-dark)"
      : isPrimary
        ? "var(--vx-terra)"
        : "var(--vx-ink-soft)";
  // ALL features show inline. Originally sliced to top 4 to keep cards
  // uniform height, but Mr. Nolan (Oak Park 7 call, May 27 PM) + Roy
  // explicitly asked: "I'd rather populate by itself instead of clicking
  // on it because some homeowners ain't that savvy." Showing the full
  // feature list inline means the value-anchor for each tier is visible
  // at first glance — no hidden value behind an accordion. The
  // "What else is included" accordion still toggles the warranty text
  // block (which is verbose and benefits from gating).
  const topFeatures = tier.tier.features;
  return (
    <div
      style={{
        position: "relative",
        border: `1px solid ${isPrimary ? "var(--vx-terra)" : "var(--vx-rule)"}`,
        borderWidth: isPrimary ? "2px" : "1px",
        borderRadius: "12px",
        padding: "18px 16px 16px",
        background: isPrimary
          ? "rgba(199, 107, 63, 0.06)"
          : "transparent",
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      {/* Exclusivity badge for the premium tier — anchors on the
          CertainTeed Premier Roofing Contractor credential (only
          2 in Central Florida). Anti-status authority signal: the
          top tier isn't "the most expensive," it's "the one
          almost nobody else can offer." */}
      {tier.tier.exclusiveClaim && (
        <span
          style={{
            position: "absolute",
            top: "-10px",
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--vx-terra-dark)",
            color: "white",
            fontSize: "9.5px",
            fontWeight: 700,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            padding: "3px 10px",
            borderRadius: "999px",
            whiteSpace: "nowrap",
          }}
        >
          Only 2 in C-Florida
        </span>
      )}

      {/* "Most chosen" badge for the primary tier. Decoy + Mimetic
          desire: takes the cognitive load off the customer by telling
          them which tier most others pick — the most common decision
          shortcut in pricing-page UX. */}
      {isPrimary && (
        <span
          style={{
            position: "absolute",
            top: "-10px",
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--vx-terra)",
            color: "white",
            fontSize: "9.5px",
            fontWeight: 700,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            padding: "3px 10px",
            borderRadius: "999px",
            whiteSpace: "nowrap",
          }}
        >
          Most chosen
        </span>
      )}

      {/* Eyebrow chip — paper's "Basic Protection" / "Popular" /
          "Premium Protection System" label. Maps the website tier
          card 1:1 to what Noland's rep hands the homeowner on
          paper. Reduces friction at sit-down ("oh, this is the
          Popular package I already saw online"). */}
      <div
        style={{
          fontSize: "9px",
          fontWeight: 700,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "var(--vx-muted)",
          textAlign: "center",
          marginBottom: "2px",
        }}
      >
        {tier.tier.eyebrow}
      </div>

      {/* Tier name — eyebrow style, colored by accent. */}
      <div
        className="eyebrow"
        style={{
          color: accentColor,
          fontWeight: 700,
          marginBottom: "6px",
          textAlign: "center",
        }}
      >
        {tier.tier.name}
      </div>

      {/* Wind MPH + CertainTeed warranty badge row — concrete,
          numeric differentiation that maps tier-to-tier on the
          paper estimate. All CertainTeed shingles carry 160 mph
          wind rating (confirmed May 2026 — every CT line meets the
          Class H rating); tier differentiation comes from the
          credentialed warranty + shingle line, not the mph number. */}
      <div
        className="tabular"
        style={{
          display: "flex",
          justifyContent: "center",
          gap: "8px",
          marginBottom: "10px",
          fontSize: "10px",
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: accentColor,
        }}
      >
        <span>{tier.tier.windMph} mph wind</span>
        <span aria-hidden="true" style={{ color: "var(--vx-rule)" }}>·</span>
        <span>CertainTeed {tier.tier.ctWarranty}</span>
      </div>

      {/* Price block — TOTAL on top (anchor), MONTHLY below (affordability).
          Hormozi pricing-display rule: show smallest increment AND full
          anchor simultaneously. Two-number CRO discipline:
            • TOTAL is the comparison number every roofer in Florida is
              measured by. Hiding it makes the customer assume the worst.
            • MONTHLY is the "can I afford this?" decision the financing
              partners (Service Finance / GreenSky / Hearth) capture.
          Both are visible at the same time so the customer can switch
          frames without scrolling or clicking.

          Layout order, top-down:
            1. tiny eyebrow "TOTAL CASH PRICE"
            2. $XX,XXX  (big, serif, primary)
            3. inline divider "─ or financed ─"
            4. $YY/mo  (medium, serif, secondary)
            5. micro caption "15 yr · 11.99% APR"

          PRICING_CONFIRMED gate: when the env is unset/false (rare,
          pre-launch only) we fall back to the original
          "final price at walkthrough" pratfall. Production is now
          NEXT_PUBLIC_PRICING_CONFIRMED=true so this gate stays open. */}
      {PRICING_CONFIRMED ? (
        <div style={{ textAlign: "center", marginBottom: "14px" }}>
          {/* TOTAL — the anchor. */}
          <div
            style={{
              fontSize: "9px",
              fontWeight: 700,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: "var(--vx-muted)",
              marginBottom: "3px",
            }}
          >
            Total cash price
          </div>
          <div
            className="font-serif tabular"
            style={{
              fontSize: "30px",
              fontWeight: 500,
              color: "var(--vx-ink)",
              letterSpacing: "-0.015em",
              lineHeight: 1,
              marginBottom: "10px",
            }}
          >
            ${tier.total.toLocaleString()}
          </div>

          {/* Divider — visually separates the two payment frames so the
              eye doesn't blur them into a single ambiguous number. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              margin: "0 auto 8px",
              maxWidth: "140px",
              fontSize: "9px",
              fontWeight: 600,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: "var(--vx-muted)",
            }}
          >
            <span style={{ flex: 1, height: "1px", background: "var(--vx-rule)" }} />
            <span>or financed</span>
            <span style={{ flex: 1, height: "1px", background: "var(--vx-rule)" }} />
          </div>

          {/* MONTHLY — affordability frame, smaller than the anchor. */}
          <div
            className="font-serif tabular"
            style={{
              fontSize: "20px",
              fontWeight: 500,
              color: "var(--vx-ink-soft)",
              letterSpacing: "-0.015em",
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
                marginLeft: "3px",
              }}
            >
              /mo
            </span>
          </div>
          <div
            className="tabular"
            style={{
              fontSize: "10px",
              letterSpacing: "0.04em",
              color: "var(--vx-muted)",
              fontFamily: "var(--vx-font-ui)",
              marginTop: "3px",
            }}
          >
            15 yr · 11.99% APR
          </div>
        </div>
      ) : (
        // Pre-launch fallback. PRICING_CONFIRMED=false hides both numbers
        // and shows the walkthrough pratfall. Should rarely render in prod.
        <div style={{ textAlign: "center", marginBottom: "12px" }}>
          <div
            className="font-serif tabular"
            style={{
              fontSize: "28px",
              fontWeight: 500,
              color: "var(--vx-ink)",
              letterSpacing: "-0.015em",
              lineHeight: 1,
            }}
          >
            ${tier.monthly.toLocaleString()}
            <span
              style={{
                fontFamily: "var(--vx-font-ui)",
                fontSize: "12px",
                fontWeight: 600,
                letterSpacing: "0.04em",
                color: "var(--vx-muted)",
                marginLeft: "4px",
              }}
            >
              /mo
            </span>
          </div>
          <div
            className="tabular"
            style={{
              fontSize: "11px",
              letterSpacing: "0.04em",
              color: "var(--vx-muted)",
              fontFamily: "var(--vx-font-ui)",
              marginTop: "4px",
            }}
          >
            est. financed · final price at walkthrough
          </div>
        </div>
      )}

      {/* Visible feature list — checkmarks. Always rendered, the
          conversion-critical piece of HI-2. */}
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          fontSize: "12px",
          color: "var(--vx-ink-soft)",
          lineHeight: 1.5,
          flex: 1,
        }}
      >
        {topFeatures.map((f, i) => (
          <li
            key={i}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "8px",
              marginBottom: "6px",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                color: "var(--vx-terra)",
                fontWeight: 700,
                flexShrink: 0,
                marginTop: "1px",
              }}
            >
              ✓
            </span>
            <span>{f}</span>
          </li>
        ))}
      </ul>

      {/* Expand-on-click for the full feature list + warranty. The
          accordion mechanism is the same `grid-template-rows: 0fr/1fr`
          interpolation TierRow used — keeps animation behavior
          consistent across the page. */}
      {(tier.tier.features.length > topFeatures.length || tier.tier.warranty) && (
        <>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isOpen}
            style={{
              marginTop: "12px",
              background: "none",
              border: 0,
              padding: 0,
              cursor: "pointer",
              fontSize: "11px",
              letterSpacing: "0.06em",
              fontWeight: 600,
              color: accentColor,
              textAlign: "center",
              width: "100%",
            }}
          >
            {isOpen ? "Show less" : "What else is included →"}
          </button>
          <div
            style={{
              display: "grid",
              gridTemplateRows: isOpen ? "1fr" : "0fr",
              transition:
                "grid-template-rows 280ms cubic-bezier(0.4, 0, 0.2, 1)",
            }}
            aria-hidden={!isOpen}
          >
            <div
              style={{
                overflow: "hidden",
                opacity: isOpen ? 1 : 0,
                transition: "opacity 200ms ease",
                transitionDelay: isOpen ? "60ms" : "0ms",
              }}
            >
              <div
                style={{
                  marginTop: "10px",
                  paddingTop: "10px",
                  borderTop: "1px dashed var(--vx-rule)",
                  fontSize: "12px",
                  color: "var(--vx-ink-soft)",
                  lineHeight: 1.5,
                }}
              >
                {tier.tier.features.length > topFeatures.length && (
                  <ul
                    style={{
                      listStyle: "none",
                      padding: 0,
                      margin: 0,
                      marginBottom: "8px",
                    }}
                  >
                    {tier.tier.features.slice(topFeatures.length).map((f, i) => (
                      <li
                        key={i}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: "8px",
                          marginBottom: "5px",
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            color: "var(--vx-terra)",
                            fontWeight: 700,
                            flexShrink: 0,
                            marginTop: "1px",
                          }}
                        >
                          ✓
                        </span>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div
                  style={{
                    fontSize: "10.5px",
                    letterSpacing: "0.10em",
                    textTransform: "uppercase",
                    color: accentColor,
                    fontWeight: 700,
                    lineHeight: 1.35,
                  }}
                >
                  {tier.tier.warranty}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Good / Better / Best tier row (deprecated by TierCard) ───────────
//
// Retained TEMPORARILY for any out-of-tree callers I haven't grep'd.
// Not used inside this file. Safe to remove in a follow-up once a
// repo-wide grep confirms zero references.

function TierRow({
  tier,
  isOpen,
  onToggle,
}: {
  tier: TierPrice;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const open = isOpen;
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
        onClick={onToggle}
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
      {/* Smoothly animated expandable region. The grid-template-rows
          1fr/0fr trick gives content-aware height animation without
          needing to guess a max-height upper bound. Modern browsers
          (Chrome 117+, Safari 17.4+, Firefox 124+) handle the
          interpolation between 0fr and 1fr cleanly; older browsers
          fall back to an instant swap which is the same as the prior
          no-animation behavior. The inner div uses overflow: hidden +
          a delayed opacity ramp so the text fades in/out in sync with
          the height transition.
          aria-hidden flips with `open` so screen readers don't see
          collapsed content. */}
      <div
        style={{
          display: "grid",
          gridTemplateRows: open ? "1fr" : "0fr",
          transition: "grid-template-rows 280ms cubic-bezier(0.4, 0, 0.2, 1)",
        }}
        aria-hidden={!open}
      >
        <div
          style={{
            overflow: "hidden",
            opacity: open ? 1 : 0,
            transition: "opacity 200ms ease",
            transitionDelay: open ? "60ms" : "0ms",
          }}
        >
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
        </div>
      </div>
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
        <Link href="/" className="leading-none" aria-label="Noland's Roofing — home">
          {/* Header wordmark matches the footer size (lg) — both lockups
              are now identical in stroke weight so the customer reads
              one consistent brand mark from hero to footer. */}
          <Wordmark size="lg" tone="ink" />
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
  // Dark-variant footer — Noland's brand on this fork.
  // Uses explicit noland tokens (not vx-ink/vx-paper) because the
  // token re-mapping inverted those: vx-ink is now silver-light
  // (text color) and vx-paper is now black-soft (surface). Using
  // the explicit tokens here guarantees the footer stays dark
  // regardless of future token shifts.
  return (
    <footer className="relative z-10" style={{ background: "var(--color-noland-black)", color: "var(--color-noland-silver-light)" }}>
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
              Clermont&apos;s #1 choice · Severe Weather Specialists
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
              Contact
            </div>
            {/* Mobile tap-target polish (May 27 PM audit): footer links
                were 15px tall. Bumped to inline-block + 12px vertical
                padding so each link is ~44px tall on phone without
                touching the visual footprint on desktop. */}
            <ul
              className="space-y-1"
              style={{ fontSize: "14px", color: "rgba(236, 227, 208, 0.78)", fontWeight: 600 }}
            >
              <li>
                <a
                  href="mailto:info@nolandsroofing.com"
                  className="inline-block py-2"
                  style={{ minHeight: 44 }}
                >
                  info@nolandsroofing.com
                </a>
              </li>
              <li className="tabular">
                <a
                  href="tel:+13522424322"
                  className="inline-block py-2"
                  style={{ minHeight: 44 }}
                >
                  (352) 242-4322
                </a>
              </li>
            </ul>
          </div>
          <div className="lg:col-span-3">
            <div className="eyebrow mb-5" style={{ color: "rgba(236, 227, 208, 0.55)" }}>
              Particulars
            </div>
            <ul
              className="space-y-1"
              style={{ fontSize: "14px", color: "rgba(236, 227, 208, 0.78)", fontWeight: 600 }}
            >
              <li className="flex items-center gap-3">
                <Link href="/privacy" className="inline-block py-2" style={{ minHeight: 44 }}>
                  Privacy
                </Link>
                <span style={{ color: "rgba(236, 227, 208, 0.32)" }}>·</span>
                <Link href="/terms" className="inline-block py-2" style={{ minHeight: 44 }}>
                  Terms
                </Link>
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
          <span>© {new Date().getFullYear()} Noland&apos;s Roofing, Inc.</span>
          <span>Clermont · Florida</span>
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
