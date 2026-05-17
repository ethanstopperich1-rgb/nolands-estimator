"use client";

/**
 * /dashboard/estimate — internal estimator (rep workbench).
 *
 * Mirrors what the customer sees at `/` and adds rep-only context that
 * the customer doesn't need: storm history, imagery-vs-storm correlation,
 * lead context, line-item penetration translation, squares + waste,
 * tear-off tonnage + dumpster sizing, drive-there link, and a composite
 * measurement-confidence score.
 *
 * Deep-link: `/dashboard/estimate?leadId=lead_xxx` (rep clicks a lead in
 * /dashboard/leads → lands here with the address pre-loaded and the
 * measurement auto-running).
 *
 * All source-of-truth labels are deliberately opaque. The rep sees
 * "measurement", "auto-detected outline", "verified by secondary source"
 * — never the underlying provider names. Rationale: the rep doesn't need
 * to know which provider produced which pixel; surfacing it adds noise
 * and creates training-leak risk in screenshots / shared links.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { loadGoogle } from "@/lib/google";
import { MATERIAL_RATES } from "@/lib/pricing";
import {
  ARCHITECTURAL_SHINGLE_RATE_PER_SQFT,
  calculateCustomerPrice,
  calculateSuggestedWaste,
} from "@/lib/pricing/calculate-waste";
import type { Material } from "@/types/estimate";

type Step = "address" | "pin" | "loading" | "result" | "error";

interface AddressResolved {
  formatted: string;
  lat: number;
  lng: number;
  zip?: string;
}

interface EstimateResult {
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
  tile: { centerLat: number; centerLng: number; zoom: number; widthPx: number; heightPx: number };
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
  modelVersion: string;
  computedAt: string;
}

interface StormEvent {
  event_type: string;
  event_begin_time: string;
  magnitude: number | null;
  magnitude_type: string | null;
  distance_miles: number;
}
interface HailEvent {
  date: string;
  maxSizeInches: number;
  distance_miles: number;
}
interface LeadRow {
  public_id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  source: string | null;
  tcpa_consent: boolean | null;
  tcpa_consent_at: string | null;
  created_at: string;
  notes: string | null;
}

const LOADING_MESSAGES = [
  { at: 0, text: "Fetching satellite imagery…" },
  { at: 3, text: "Measuring the roof…" },
  { at: 7, text: "Identifying the outline…" },
  { at: 13, text: "Tracing roof features…" },
  { at: 19, text: "Detecting penetrations…" },
];

export default function DashboardEstimatePage() {
  return (
    <Suspense fallback={<div className="p-10 text-slate-400 text-sm">Loading…</div>}>
      <EstimatePage />
    </Suspense>
  );
}

function EstimatePage() {
  const searchParams = useSearchParams();
  const queryLeadId = searchParams.get("leadId");

  const [step, setStep] = useState<Step>("address");
  const [resolved, setResolved] = useState<AddressResolved | null>(null);
  const [pinLat, setPinLat] = useState<number | null>(null);
  const [pinLng, setPinLng] = useState<number | null>(null);
  const [result, setResult] = useState<EstimateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingElapsed, setLoadingElapsed] = useState(0);

  // Rep-side inputs
  const [material, setMaterial] = useState<Material>("asphalt-architectural");
  const [manualPitchOn12, setManualPitchOn12] = useState<number>(5);
  const [tearOff, setTearOff] = useState<boolean>(true);
  const [laborMult, setLaborMult] = useState<number>(1.0);
  const [materialMult, setMaterialMult] = useState<number>(1.0);
  const [notes, setNotes] = useState("");

  // Rep-only enrichments
  const [lead, setLead] = useState<LeadRow | null>(null);
  const [storms, setStorms] = useState<StormEvent[] | null>(null);
  const [hail, setHail] = useState<HailEvent[] | null>(null);

  // Load lead from deep link
  useEffect(() => {
    if (!queryLeadId) return;
    let cancelled = false;
    fetch(`/api/leads/${encodeURIComponent(queryLeadId)}`)
      .then(async (r) => (r.ok ? ((await r.json()) as { lead?: LeadRow }) : null))
      .then((data) => {
        if (cancelled || !data?.lead) return;
        setLead(data.lead);
        if (data.lead.lat != null && data.lead.lng != null && data.lead.address) {
          const addr: AddressResolved = {
            formatted: data.lead.address,
            lat: data.lead.lat,
            lng: data.lead.lng,
          };
          setResolved(addr);
          setPinLat(addr.lat);
          setPinLng(addr.lng);
          setStep("pin");
        }
        if (data.lead.notes) setNotes(data.lead.notes);
      })
      .catch(() => {
        /* Lead lookup failed — rep proceeds manually */
      });
    return () => {
      cancelled = true;
    };
  }, [queryLeadId]);

  // Loading timer
  useEffect(() => {
    if (step !== "loading") return;
    const t0 = Date.now();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on entering loading step
    setLoadingElapsed(0);
    const id = window.setInterval(() => setLoadingElapsed(Math.floor((Date.now() - t0) / 1000)), 250);
    return () => window.clearInterval(id);
  }, [step]);

  // Fetch storm history once we have a result
  useEffect(() => {
    if (!result || pinLat == null || pinLng == null) return;
    let cancelled = false;
    Promise.allSettled([
      fetch(`/api/storms?lat=${pinLat}&lng=${pinLng}&radiusMiles=5&yearsBack=5`).then(async (r) =>
        r.ok ? ((await r.json()) as { events?: StormEvent[] }) : null,
      ),
      fetch(`/api/hail-mrms?lat=${pinLat}&lng=${pinLng}&radiusMiles=2&yearsBack=3`).then(async (r) =>
        r.ok ? ((await r.json()) as { events?: HailEvent[] }) : null,
      ),
    ]).then(([sRes, hRes]) => {
      if (cancelled) return;
      if (sRes.status === "fulfilled" && sRes.value?.events) setStorms(sRes.value.events);
      else setStorms([]);
      if (hRes.status === "fulfilled" && hRes.value?.events) setHail(hRes.value.events);
      else setHail([]);
    });
    return () => {
      cancelled = true;
    };
  }, [result, pinLat, pinLng]);

  const runEstimate = useCallback(async (): Promise<void> => {
    if (pinLat == null || pinLng == null) return;
    setStep("loading");
    setError(null);
    setResult(null);
    setStorms(null);
    setHail(null);
    try {
      const res = await fetch(`/api/gemini-roof?lat=${pinLat}&lng=${pinLng}&pinConfirmed=1`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Measurement service ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as EstimateResult;
      setResult(data);
      setStep("result");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("error");
    }
  }, [pinLat, pinLng]);

  function startOver(): void {
    setStep("address");
    setResolved(null);
    setPinLat(null);
    setPinLng(null);
    setResult(null);
    setError(null);
    setStorms(null);
    setHail(null);
    setLead(null);
  }

  const effectivePitchDeg = useMemo(() => {
    if (result?.solar.pitchDegrees != null) return result.solar.pitchDegrees;
    return Math.atan(manualPitchOn12 / 12) * (180 / Math.PI);
  }, [result, manualPitchOn12]);

  const effectiveSqft = useMemo(() => {
    if (!result) return null;
    if (result.solar.sqft != null) return result.solar.sqft;
    if (result.solar.footprintSqft != null) {
      const slope = 1 / Math.cos((effectivePitchDeg * Math.PI) / 180);
      return Math.round(result.solar.footprintSqft * slope);
    }
    return null;
  }, [result, effectivePitchDeg]);

  // Composite confidence (0–100). Inputs are all live-pipeline values.
  const confidence = useMemo(() => {
    if (!result) return null;
    let score = 0;
    const basis: string[] = [];
    // Imagery quality contributes 0/35/55/70 (LOW/MED/HIGH/null-default)
    const q = result.solar.imageryQuality;
    if (q === "HIGH") {
      score += 55;
      basis.push("high-resolution imagery");
    } else if (q === "MEDIUM") {
      score += 35;
      basis.push("medium-resolution imagery");
    } else if (q === "LOW") {
      score += 18;
      basis.push("low-resolution imagery");
    }
    // Imagery age — 0/5/10/15 (none/old/recent/very-recent)
    const ageYears = imageryAgeYears(result.solar.imageryDate);
    if (ageYears != null) {
      if (ageYears <= 1) {
        score += 15;
        basis.push("imagery <1y old");
      } else if (ageYears <= 2) {
        score += 10;
        basis.push(`imagery ${ageYears.toFixed(1)}y old`);
      } else if (ageYears <= 4) {
        score += 5;
        basis.push(`imagery ${ageYears.toFixed(1)}y old`);
      } else {
        basis.push(`imagery ${ageYears.toFixed(1)}y old`);
      }
    }
    // No fallback applied → +20; fallback applied → 0
    if (result.correction == null || !result.correction.applied) {
      score += 20;
    } else {
      basis.push("verified using secondary footprint source");
    }
    // Segment count agrees with facet count → +10
    if (
      result.solar.segmentCount > 0 &&
      Math.abs(result.solar.segmentCount - result.facets.length) <= 1
    ) {
      score += 10;
    }
    return { score: Math.min(100, score), basis };
  }, [result]);

  // Squares + waste factor — derived purely from V3 sqft + complexity.
  const squaresAndWaste = useMemo(() => {
    if (effectiveSqft == null || !result) return null;
    const wasteByComplexity = { simple: 0.06, moderate: 0.11, complex: 0.14 } as const;
    const waste = wasteByComplexity[result.derived.complexity];
    const squares = effectiveSqft / 100;
    const orderedSquares = squares * (1 + waste);
    return {
      base: Math.round(squares * 10) / 10,
      waste,
      ordered: Math.ceil(orderedSquares * 10) / 10,
      bundles: Math.ceil(orderedSquares * 3),
    };
  }, [effectiveSqft, result]);

  // Tear-off tonnage + dumpster size — derived from sqft + material.
  const tearOffPlan = useMemo(() => {
    if (effectiveSqft == null || !tearOff) return null;
    // Roughly 2.5 lbs/sqft single-layer asphalt; 3-tab heavier than dimensional.
    // Concrete tile ≈ 9 lbs/sqft. Metal layover → no tear-off.
    const lbsPerSqft =
      material === "tile-concrete" ? 9 : material === "metal-standing-seam" ? 0 : 2.5;
    if (lbsPerSqft === 0) return null;
    const lbs = effectiveSqft * lbsPerSqft;
    const tons = lbs / 2000;
    // Dumpster sizing — 10 yd ≈ 1 ton, 20 yd ≈ 2 ton, 30 yd ≈ 4 ton (mixed C&D).
    const dumpster =
      tons <= 1.5 ? "10-yard" : tons <= 3 ? "20-yard" : tons <= 5 ? "30-yard" : "40-yard";
    return { tons: Math.round(tons * 10) / 10, dumpster };
  }, [effectiveSqft, material, tearOff]);

  // Penetration → line-item translation (vents, chimneys, skylights, HVAC).
  const lineItems = useMemo(() => {
    if (!result) return null;
    const counts: Record<string, number> = {};
    for (const o of result.objects) counts[o.type] = (counts[o.type] ?? 0) + 1;
    const items: Array<{ qty: number; description: string }> = [];
    if (counts.vent) items.push({ qty: counts.vent, description: "Plumbing vent pipe boot" });
    if (counts.stack) items.push({ qty: counts.stack, description: "Stack flashing" });
    if (counts.chimney) {
      items.push({ qty: counts.chimney, description: "Chimney flashing kit (apron + step)" });
      items.push({ qty: counts.chimney, description: "Chimney counter-flashing / cricket as required" });
    }
    if (counts.skylight) items.push({ qty: counts.skylight, description: "Skylight flashing kit" });
    if (counts.hvac) items.push({ qty: counts.hvac, description: "HVAC curb flashing" });
    if (counts.dormer) items.push({ qty: counts.dormer, description: "Dormer step + headwall flashing" });
    // Edge linear feet → ridge/hip/valley/rake/eave line items
    if (result.edges.ridgesHipsLf != null && result.edges.ridgesHipsLf > 0) {
      items.push({
        qty: Math.ceil(result.edges.ridgesHipsLf),
        description: "Ridge / hip cap (LF)",
      });
    }
    if (result.edges.valleysLf != null && result.edges.valleysLf > 0) {
      items.push({ qty: Math.ceil(result.edges.valleysLf), description: "Valley metal (LF)" });
    }
    if (result.edges.rakesLf != null && result.edges.rakesLf > 0) {
      items.push({ qty: Math.ceil(result.edges.rakesLf), description: "Rake edge / drip edge (LF)" });
    }
    if (result.edges.eavesLf != null && result.edges.eavesLf > 0) {
      items.push({ qty: Math.ceil(result.edges.eavesLf), description: "Eave drip edge + starter (LF)" });
    }
    return items;
  }, [result]);

  // Storm-vs-imagery: count storms that occurred AFTER the imagery date.
  const stormsAfterImagery = useMemo(() => {
    if (!result?.solar.imageryDate) return null;
    if (storms == null && hail == null) return null;
    const cutoff = new Date(result.solar.imageryDate).getTime();
    const after: Array<{ date: string; label: string; mag: string }> = [];
    for (const s of storms ?? []) {
      const d = new Date(s.event_begin_time).getTime();
      if (d > cutoff) {
        after.push({
          date: s.event_begin_time.slice(0, 10),
          label: s.event_type,
          mag: s.magnitude != null ? `${s.magnitude}${s.magnitude_type ?? ""}` : "—",
        });
      }
    }
    for (const h of hail ?? []) {
      const d = new Date(h.date).getTime();
      if (d > cutoff) {
        after.push({
          date: h.date.slice(0, 10),
          label: "Hail (radar-derived)",
          mag: `${h.maxSizeInches.toFixed(2)}″`,
        });
      }
    }
    after.sort((a, b) => (a.date < b.date ? 1 : -1));
    return after.slice(0, 8);
  }, [result, storms, hail]);

  // Pricing — V3 sqft × material rate × multipliers.
  const pricing = useMemo(() => {
    if (effectiveSqft == null || effectiveSqft <= 0) return null;
    const rates = MATERIAL_RATES[material];
    const tearLow = tearOff ? rates.removeLow : 0;
    const tearHigh = tearOff ? rates.removeHigh : 0;
    const baseLow = effectiveSqft * rates.low * materialMult * laborMult;
    const baseMid = effectiveSqft * rates.rate * materialMult * laborMult;
    const baseHigh = effectiveSqft * rates.high * materialMult * laborMult;
    return {
      mid: Math.round(baseMid + ((tearLow + tearHigh) / 2) * effectiveSqft),
      low: Math.round(baseLow + tearLow * effectiveSqft),
      high: Math.round(baseHigh + tearHigh * effectiveSqft),
      rateLabel: rates.label,
    };
  }, [effectiveSqft, material, tearOff, materialMult, laborMult]);

  return (
    <div className="min-h-[100dvh] px-6 lg:px-10 py-8 text-slate-100">
      <header className="max-w-6xl mx-auto mb-8">
        <p className="text-[10px] uppercase tracking-[0.22em] text-slate-400">
          {lead ? `Lead · ${lead.name ?? lead.email ?? lead.public_id}` : "New estimate"}
        </p>
        <h1 className="font-display text-3xl mt-2 leading-tight">
          Roof <span className="text-cy-400">workbench</span>
        </h1>
      </header>

      <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
        <main className="space-y-6">
          {step === "address" && (
            <AddressStep
              onResolved={(addr) => {
                setResolved(addr);
                setPinLat(addr.lat);
                setPinLng(addr.lng);
                setStep("pin");
              }}
            />
          )}
          {step === "pin" && resolved && (
            <PinStep
              resolved={resolved}
              pinLat={pinLat}
              pinLng={pinLng}
              onPinMove={(lat, lng) => {
                setPinLat(lat);
                setPinLng(lng);
              }}
              onBack={startOver}
              onConfirm={runEstimate}
            />
          )}
          {step === "loading" && (
            <LoadingPanel elapsed={loadingElapsed} message={loadingMessageFor(loadingElapsed)} />
          )}
          {step === "result" && result && resolved && (
            <ResultPanels
              result={result}
              resolved={resolved}
              effectiveSqft={effectiveSqft}
              effectivePitchDeg={effectivePitchDeg}
              confidence={confidence}
              squaresAndWaste={squaresAndWaste}
              tearOffPlan={tearOffPlan}
              lineItems={lineItems}
              storms={storms}
              hail={hail}
              stormsAfterImagery={stormsAfterImagery}
              pinLat={pinLat}
              pinLng={pinLng}
              onReRun={runEstimate}
            />
          )}
          {step === "error" && (
            <div className="rounded-2xl border border-rose/40 bg-rose/5 p-6">
              <p className="text-rose font-medium">Measurement failed</p>
              <p className="text-sm text-slate-300 mt-2">{error}</p>
              <button type="button" onClick={startOver} className="mt-4 text-sm text-cy-400 underline">
                Start over
              </button>
            </div>
          )}
        </main>

        <aside className="space-y-6">
          {lead && <LeadContextCard lead={lead} />}
          <RepInputs
            material={material}
            setMaterial={setMaterial}
            manualPitchOn12={manualPitchOn12}
            setManualPitchOn12={setManualPitchOn12}
            pitchAutoDetected={result?.solar.pitchDegrees ?? null}
            tearOff={tearOff}
            setTearOff={setTearOff}
            laborMult={laborMult}
            setLaborMult={setLaborMult}
            materialMult={materialMult}
            setMaterialMult={setMaterialMult}
          />
          <NotesCard notes={notes} setNotes={setNotes} />
          {pricing && <PricingCard pricing={pricing} sqft={effectiveSqft} pitchDeg={effectivePitchDeg} />}
        </aside>
      </div>
    </div>
  );
}

function loadingMessageFor(elapsed: number): string {
  return LOADING_MESSAGES.filter((m) => m.at <= elapsed).pop()?.text ?? LOADING_MESSAGES[0].text;
}

function imageryAgeYears(imageryDate: string | null): number | null {
  if (!imageryDate) return null;
  const t = new Date(imageryDate).getTime();
  if (isNaN(t)) return null;
  return (Date.now() - t) / (365.25 * 24 * 60 * 60 * 1000);
}

function pitchToOnTwelve(deg: number): string {
  if (deg <= 0) return "flat";
  const rise = Math.tan((deg * Math.PI) / 180) * 12;
  return `${Math.max(1, Math.round(rise))}/12`;
}

// ─── Address autocomplete ────────────────────────────────────────────────

function AddressStep({ onResolved }: { onResolved: (a: AddressResolved) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!inputRef.current) return;
    let cancelled = false;
    let ac: google.maps.places.Autocomplete | null = null;
    loadGoogle()
      .then((g) => {
        if (cancelled || !inputRef.current) return;
        ac = new g.maps.places.Autocomplete(inputRef.current, {
          types: ["address"],
          componentRestrictions: { country: "us" },
          fields: ["formatted_address", "geometry", "address_components"],
        });
        ac.addListener("place_changed", () => {
          const place = ac!.getPlace();
          const loc = place.geometry?.location;
          if (!loc) return;
          const zip = place.address_components?.find((c) =>
            c.types.includes("postal_code"),
          )?.short_name;
          onResolved({
            formatted: place.formatted_address ?? inputRef.current!.value,
            lat: loc.lat(),
            lng: loc.lng(),
            zip,
          });
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [onResolved]);
  return (
    <section className="rounded-2xl border border-ink-700 bg-ink-900/80 p-6">
      <label htmlFor="address" className="block text-[10px] uppercase tracking-[0.22em] text-slate-400 mb-3">
        Property address
      </label>
      <input
        ref={inputRef}
        id="address"
        type="text"
        placeholder="123 Main St, Jupiter, FL 33458"
        className="w-full bg-ink-800 border border-ink-600 rounded-xl px-4 py-3 text-base text-slate-100 placeholder-slate-500 outline-none focus:border-cy-400"
        autoFocus
        spellCheck={false}
        autoComplete="off"
      />
      <p className="text-xs text-slate-500 mt-3">
        Pick from the dropdown. Next step you&apos;ll drop a pin on the exact center of the roof.
      </p>
    </section>
  );
}

// ─── Pin confirm ────────────────────────────────────────────────────────

function PinStep({
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
  const markerRef = useRef<google.maps.Marker | null>(null);
  useEffect(() => {
    if (!mapElRef.current) return;
    let cancelled = false;
    loadGoogle().then((g) => {
      if (cancelled || !mapElRef.current) return;
      const map = new g.maps.Map(mapElRef.current, {
        center: { lat: resolved.lat, lng: resolved.lng },
        zoom: 20,
        mapTypeId: g.maps.MapTypeId.SATELLITE,
        tilt: 0,
        disableDefaultUI: true,
        gestureHandling: "greedy",
        zoomControl: true,
        keyboardShortcuts: false,
      });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section className="rounded-2xl border border-ink-700 bg-ink-900/80 overflow-hidden">
      <div className="p-4 border-b border-ink-700/60">
        <p className="text-[10px] uppercase tracking-[0.18em] text-cy-400">
          Drag pin to the center of the roof
        </p>
        <p className="text-sm text-slate-300 mt-1">{resolved.formatted}</p>
      </div>
      <div ref={mapElRef} className="w-full" style={{ aspectRatio: "16 / 10" }} />
      <div className="p-4 flex justify-between gap-3 border-t border-ink-700/60">
        <button
          type="button"
          onClick={onBack}
          className="text-[11px] uppercase tracking-[0.18em] text-slate-400 hover:text-slate-200"
        >
          ← Different address
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="px-5 py-2.5 rounded-xl bg-cy-500 hover:bg-cy-400 text-ink-900 font-medium text-sm"
        >
          Run measurement →
        </button>
      </div>
    </section>
  );
}

// ─── Loading panel ──────────────────────────────────────────────────────

function LoadingPanel({ elapsed, message }: { elapsed: number; message: string }) {
  const pct = Math.min(100, Math.round((elapsed / 22) * 100));
  return (
    <section className="rounded-2xl border border-ink-700 bg-ink-900/80 p-8 text-center">
      <p className="text-[10px] uppercase tracking-[0.18em] text-cy-400">Measuring</p>
      <h2 className="font-display text-2xl mt-3">{message}</h2>
      <div className="mt-6 mx-auto max-w-xs h-px bg-ink-700 relative overflow-hidden">
        <div className="absolute inset-y-0 left-0 bg-cy-400 transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-3 text-[10px] tracking-[0.18em] uppercase text-slate-400 tabular-nums">
        {Math.min(elapsed, 22)} / 22 sec
      </p>
    </section>
  );
}

// ─── Result panels ──────────────────────────────────────────────────────

function ResultPanels({
  result,
  resolved,
  effectiveSqft,
  effectivePitchDeg,
  confidence,
  squaresAndWaste,
  tearOffPlan,
  lineItems,
  storms,
  hail,
  stormsAfterImagery,
  pinLat,
  pinLng,
  onReRun,
}: {
  result: EstimateResult;
  resolved: AddressResolved;
  effectiveSqft: number | null;
  effectivePitchDeg: number;
  confidence: { score: number; basis: string[] } | null;
  squaresAndWaste: { base: number; waste: number; ordered: number; bundles: number } | null;
  tearOffPlan: { tons: number; dumpster: string } | null;
  lineItems: Array<{ qty: number; description: string }> | null;
  storms: StormEvent[] | null;
  hail: HailEvent[] | null;
  stormsAfterImagery: Array<{ date: string; label: string; mag: string }> | null;
  pinLat: number | null;
  pinLng: number | null;
  onReRun: () => void;
}) {
  const driveLink =
    pinLat != null && pinLng != null ? `https://www.google.com/maps/?q=${pinLat},${pinLng}` : null;
  return (
    <div className="space-y-6">
      {/* Painted outline */}
      {result.paintedImageBase64 && (
        <section className="rounded-2xl border border-ink-700 bg-ink-900/80 overflow-hidden">
          <div className="p-3 border-b border-ink-700/60 flex justify-between items-center">
            <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">
              Roof outline
            </p>
            <button type="button" onClick={onReRun} className="text-[10px] uppercase tracking-[0.16em] text-cy-400 hover:text-cy-300">
              Re-run
            </button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`data:image/png;base64,${result.paintedImageBase64}`} alt="Roof outline" className="w-full" />
        </section>
      )}

      {/* Headline measurement + confidence */}
      <section className="rounded-2xl border border-ink-700 bg-ink-900/80 p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3 mb-5">
          <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">Measurement</p>
          {confidence && (
            <span
              className={`text-[10px] uppercase tracking-[0.18em] px-3 py-1 rounded-full border ${
                confidence.score >= 80
                  ? "border-mint/40 text-mint"
                  : confidence.score >= 55
                    ? "border-amber/40 text-amber"
                    : "border-rose/40 text-rose"
              }`}
            >
              {confidence.score >= 80 ? "High confidence" : confidence.score >= 55 ? "Medium confidence" : "Low confidence"} · {confidence.score}/100
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Metric
            label="Roof sqft"
            value={effectiveSqft != null ? effectiveSqft.toLocaleString() : "—"}
            sub={result.solar.sqft == null && effectiveSqft != null ? "from footprint + manual pitch" : null}
          />
          <Metric
            label="Footprint"
            value={result.solar.footprintSqft != null ? result.solar.footprintSqft.toLocaleString() : "—"}
          />
          <Metric
            label="Pitch (avg)"
            value={
              result.solar.pitchDegrees != null
                ? `${pitchToOnTwelve(result.solar.pitchDegrees)}`
                : `${pitchToOnTwelve(effectivePitchDeg)} (manual)`
            }
            sub={
              result.solar.pitchDegrees != null
                ? `${result.solar.pitchDegrees.toFixed(1)}°`
                : `${effectivePitchDeg.toFixed(1)}°`
            }
          />
          <Metric label="Facets" value={result.facets.length.toString()} sub={`${result.derived.complexity} roof`} />
        </div>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400">
          <span>Stories: {result.derived.stories}</span>
          {result.derived.predominantCompass && (
            <span>Predominant face: {result.derived.predominantCompass}</span>
          )}
          {confidence && confidence.basis.length > 0 && (
            <span className="text-slate-500">Basis: {confidence.basis.join(" · ")}</span>
          )}
        </div>
      </section>

      {/* Imagery freshness warning */}
      {result.solar.imageryDate && (
        <ImageryFreshnessCard imageryDate={result.solar.imageryDate} stormsAfter={stormsAfterImagery} />
      )}

      {/* Per-facet breakdown */}
      {result.facets.length > 0 && (
        <section className="rounded-2xl border border-ink-700 bg-ink-900/80 p-6">
          <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 mb-4">
            Per-facet breakdown
          </p>
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
              <tr>
                <th className="text-left py-2">#</th>
                <th className="text-left py-2">Face</th>
                <th className="text-right py-2">Pitch</th>
                <th className="text-right py-2">Roof sqft</th>
                <th className="text-right py-2">Footprint</th>
              </tr>
            </thead>
            <tbody className="tabular-nums text-slate-200">
              {result.facets.map((f, i) => (
                <tr key={i} className="border-t border-ink-700/40">
                  <td className="py-2">{i + 1}</td>
                  <td className="py-2">{f.compassDirection} ({f.azimuthDegrees.toFixed(0)}°)</td>
                  <td className="py-2 text-right">{f.pitchOnTwelve}</td>
                  <td className="py-2 text-right">{f.slopedSqft.toFixed(0)}</td>
                  <td className="py-2 text-right">{f.footprintSqft.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Squares + ordering plan */}
      {squaresAndWaste && (
        <section className="rounded-2xl border border-ink-700 bg-ink-900/80 p-6">
          <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 mb-4">
            Order quantity
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Metric label="Squares (base)" value={squaresAndWaste.base.toString()} />
            <Metric label="Waste factor" value={`${(squaresAndWaste.waste * 100).toFixed(0)}%`} sub={`${result.derived.complexity} roof`} />
            <Metric label="Squares (order)" value={squaresAndWaste.ordered.toString()} />
            <Metric label="Bundles" value={squaresAndWaste.bundles.toString()} sub="3-bundle / sq estimate" />
          </div>
        </section>
      )}

      {/* Tear-off plan */}
      {tearOffPlan && (
        <section className="rounded-2xl border border-ink-700 bg-ink-900/80 p-6">
          <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 mb-4">Tear-off plan</p>
          <div className="grid grid-cols-2 gap-4">
            <Metric label="Debris weight" value={`${tearOffPlan.tons} tons`} />
            <Metric label="Dumpster" value={tearOffPlan.dumpster} sub="single-layer assumption" />
          </div>
        </section>
      )}

      {/* Line items */}
      {lineItems && lineItems.length > 0 && (
        <section className="rounded-2xl border border-ink-700 bg-ink-900/80 p-6">
          <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 mb-4">
            Estimated line items
          </p>
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
              <tr>
                <th className="text-left py-2">Qty</th>
                <th className="text-left py-2">Description</th>
              </tr>
            </thead>
            <tbody className="text-slate-200">
              {lineItems.map((li, i) => (
                <tr key={i} className="border-t border-ink-700/40">
                  <td className="py-2 tabular-nums">{li.qty}</td>
                  <td className="py-2">{li.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Site & condition notes — rep talking points */}
      <SiteConditionNotes ga={result.geminiAnalysis} />

      {/* Waste analysis — EagleView-style, rep-only. Customer never
          sees the percentage; we show it here with the breakdown so the
          rep can defend the number on a phone call. */}
      <WasteAnalysisCard
        result={result}
        effectiveSqft={effectiveSqft}
        effectivePitchDeg={effectivePitchDeg}
      />

      {/* Storm history */}
      <StormHistoryCard storms={storms} hail={hail} />

      {/* Drive-there + jobsite ops */}
      {driveLink && (
        <section className="rounded-2xl border border-ink-700 bg-ink-900/80 p-5">
          <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 mb-3">Jobsite</p>
          <div className="flex flex-wrap gap-2 items-center text-sm">
            <a
              href={driveLink}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 rounded-lg bg-cy-500/10 border border-cy-400/30 text-cy-300 hover:bg-cy-500/20"
            >
              Drive to roof →
            </a>
            <span className="text-slate-500 tabular-nums text-xs">
              {pinLat?.toFixed(5)}, {pinLng?.toFixed(5)}
            </span>
          </div>
          <p className="mt-2 text-xs text-slate-500">{resolved.formatted}</p>
        </section>
      )}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500 mb-1">{label}</div>
      <div className="font-display text-xl tabular-nums text-slate-100">{value}</div>
      {sub && <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function ImageryFreshnessCard({
  imageryDate,
  stormsAfter,
}: {
  imageryDate: string;
  stormsAfter: Array<{ date: string; label: string; mag: string }> | null;
}) {
  const ageY = imageryAgeYears(imageryDate) ?? 0;
  const stale = ageY > 2;
  const hasStormsAfter = stormsAfter && stormsAfter.length > 0;
  const tone =
    stale || hasStormsAfter
      ? { border: "border-amber/40", bg: "bg-amber/5", text: "text-amber", title: "Verify on-site" }
      : { border: "border-ink-700", bg: "bg-ink-900/80", text: "text-slate-400", title: "Imagery" };
  return (
    <section className={`rounded-2xl border ${tone.border} ${tone.bg} p-5`}>
      <p className={`text-[10px] uppercase tracking-[0.18em] mb-2 ${tone.text}`}>{tone.title}</p>
      <p className="text-sm text-slate-200">
        Satellite imagery dated <span className="tabular-nums">{imageryDate}</span>
        {stale && <span> · {ageY.toFixed(1)} years old — visible condition may have changed.</span>}
      </p>
      {hasStormsAfter && stormsAfter && (
        <div className="mt-3 pt-3 border-t border-amber/20">
          <p className="text-[10px] uppercase tracking-[0.18em] text-amber mb-2">
            Severe weather since imagery
          </p>
          <ul className="space-y-1 text-sm text-slate-200">
            {stormsAfter.map((s, i) => (
              <li key={i} className="flex gap-3 tabular-nums">
                <span className="text-slate-400 w-24">{s.date}</span>
                <span className="flex-1">{s.label}</span>
                <span className="text-slate-400">{s.mag}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-500">
            Damage may not be reflected in the satellite imagery — inspect on-site.
          </p>
        </div>
      )}
    </section>
  );
}

/** Rep-only site/condition observations from the vision pass. The
 *  customer page never sees this content. */
/** Rep-only waste-factor analysis. Reads from V3 (prefers gemini-detected
 *  edges over Solar-classified, mirroring the customer page) and surfaces
 *  the suggested %, what drove it, and the standard waste table — same
 *  shape EagleView's premium reports use. Plus the spec architectural
 *  shingle price ($7/sqft × sqft × (1 + waste)) so the rep can cross-
 *  check against the customer-facing total. */
function WasteAnalysisCard({
  result,
  effectiveSqft,
  effectivePitchDeg,
}: {
  result: EstimateResult;
  effectiveSqft: number | null;
  effectivePitchDeg: number;
}) {
  if (effectiveSqft == null || effectiveSqft <= 0) return null;

  // Prefer Gemini edges (more reliable on simple gable roofs) and fall
  // back to Solar-classified.
  const gEdges = result.geminiEdges as
    | { ridgesHipsLf: number; valleysLf: number } | null
    | undefined;
  const valleysLf = gEdges?.valleysLf ?? result.edges.valleysLf ?? 0;
  const ridgesHipsLf = gEdges?.ridgesHipsLf ?? result.edges.ridgesHipsLf ?? 0;

  const waste = calculateSuggestedWaste({
    facetCount: result.facets.length,
    valleysLf,
    ridgesHipsLf,
    avgPitchDeg: effectivePitchDeg,
    totalSqft: effectiveSqft,
  });
  const customerPrice = calculateCustomerPrice(effectiveSqft, waste);

  return (
    <section className="rounded-2xl border border-ink-700 bg-ink-900/80 p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-4">
        <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">
          Waste &amp; pricing analysis
        </p>
        <span className="text-[10px] uppercase tracking-[0.16em] text-cy-400">
          EagleView-style
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        <Metric label="Suggested waste" value={`${waste.suggestedPercent}%`} sub="rolled into customer total" />
        <Metric label="Complexity score" value={waste.complexityScore.toString()} sub="higher = more waste" />
        <Metric
          label="Customer total"
          value={`$${customerPrice.total.toLocaleString()}`}
          sub={`@ $${ARCHITECTURAL_SHINGLE_RATE_PER_SQFT.toFixed(2)}/sqft`}
        />
        <Metric
          label="Range"
          value={`$${customerPrice.totalLow.toLocaleString()}–$${customerPrice.totalHigh.toLocaleString()}`}
          sub="customer-visible band"
        />
      </div>

      <div className="mt-4 pt-4 border-t border-ink-700/60">
        <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500 mb-2">
          How we got to {waste.suggestedPercent}%
        </p>
        <ul className="text-sm text-slate-200 space-y-1 tabular-nums">
          <li className="flex justify-between">
            <span className="text-slate-400">
              Facets ({result.facets.length} × 0.75)
            </span>
            <span>+{waste.breakdown.fromFacets.toFixed(1)}</span>
          </li>
          <li className="flex justify-between">
            <span className="text-slate-400">
              Valleys (~{Math.round(valleysLf / 15)} events × 3.5)
            </span>
            <span>+{waste.breakdown.fromValleys.toFixed(1)}</span>
          </li>
          <li className="flex justify-between">
            <span className="text-slate-400">
              Ridges + hips (~{Math.round(ridgesHipsLf / 25)} events × 1.8)
            </span>
            <span>+{waste.breakdown.fromRidgesHips.toFixed(1)}</span>
          </li>
          <li className="flex justify-between">
            <span className="text-slate-400">
              Steep pitch ({effectivePitchDeg.toFixed(1)}° {effectivePitchDeg > 33.7 ? "> 8/12" : "≤ 8/12"})
            </span>
            <span>+{waste.breakdown.fromSteepPitch.toFixed(1)}</span>
          </li>
          <li
            className="flex justify-between border-t border-ink-700/40 pt-1 mt-1"
            style={{ fontWeight: 600 }}
          >
            <span>Base 10 + score, capped to [10, 28]</span>
            <span>{waste.suggestedPercent}%</span>
          </li>
        </ul>
      </div>

      <div className="mt-5 pt-4 border-t border-ink-700/60">
        <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500 mb-2">
          Waste table
        </p>
        <table className="w-full text-sm tabular-nums">
          <thead className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
            <tr>
              <th className="text-left py-2">Waste %</th>
              <th className="text-right py-2">Squares to order</th>
              <th className="text-right py-2">Effective sqft</th>
              <th className="text-right py-2">Total @ $7.00/sqft</th>
            </tr>
          </thead>
          <tbody className="text-slate-200">
            {waste.table.map((row) => {
              const isSuggested = row.percent === waste.suggestedPercent;
              const effective = Math.round(effectiveSqft * (1 + row.percent / 100));
              const total = Math.round(effective * ARCHITECTURAL_SHINGLE_RATE_PER_SQFT);
              return (
                <tr
                  key={row.percent}
                  className="border-t border-ink-700/40"
                  style={isSuggested ? { background: "rgba(56, 197, 238, 0.04)" } : undefined}
                >
                  <td className="py-2">
                    {row.percent}%
                    {isSuggested && (
                      <span className="ml-2 text-[9px] uppercase tracking-[0.16em] text-cy-400">
                        suggested
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-right">{row.totalSquares.toFixed(1)}</td>
                  <td className="py-2 text-right">{effective.toLocaleString()}</td>
                  <td className="py-2 text-right">${total.toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-3 text-[11px] text-slate-500 leading-relaxed">
          Suggested waste is a guide — adjust based on crew, material salvage, and
          installation patterns. The customer sees a single total with waste rolled in;
          the percentage itself is intentionally not displayed.
        </p>
      </div>
    </section>
  );
}

function SiteConditionNotes({
  ga,
}: {
  ga: EstimateResult["geminiAnalysis"];
}) {
  const nothing =
    ga.visibleDamage.length === 0 &&
    ga.secondaryStructures.length === 0 &&
    ga.siteObstacles.length === 0 &&
    ga.conditionHints.length === 0 &&
    !ga.apparentAgeBand &&
    !ga.roofMaterial;
  if (nothing) return null;
  const AGE_BAND_LABEL: Record<string, string> = {
    new_under_5y: "New (<5 yrs)",
    mid_5_to_15y: "Mid-life (5–15 yrs)",
    mature_15_to_25y: "Mature (15–25 yrs)",
    end_of_life_25y_plus: "End-of-life (25+ yrs)",
    indeterminate: "Indeterminate",
  };
  const prettify = (s: string) => s.replace(/_/g, " ");
  return (
    <section className="rounded-2xl border border-ink-700 bg-ink-900/80 p-6">
      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 mb-4">
        Site &amp; condition notes
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {ga.apparentAgeBand && (
          <div>
            <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500 mb-1">Apparent age</div>
            <div className="text-sm text-slate-100">
              {AGE_BAND_LABEL[ga.apparentAgeBand.band] ?? prettify(ga.apparentAgeBand.band)}{" "}
              <span className="text-slate-500 text-xs">
                ({(ga.apparentAgeBand.confidence * 100).toFixed(0)}%)
              </span>
            </div>
          </div>
        )}
        {ga.roofMaterial && (
          <div>
            <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500 mb-1">Material guess</div>
            <div className="text-sm text-slate-100">
              {prettify(ga.roofMaterial.type)}{" "}
              <span className="text-slate-500 text-xs">
                ({(ga.roofMaterial.confidence * 100).toFixed(0)}%)
              </span>
            </div>
          </div>
        )}
      </div>

      {ga.visibleDamage.length > 0 && (
        <div className="mt-5 pt-4 border-t border-ink-700/60">
          <div className="text-[10px] uppercase tracking-[0.16em] text-amber mb-2">Visible damage</div>
          <ul className="space-y-1.5 text-sm text-slate-200">
            {ga.visibleDamage.map((d, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-amber">·</span>
                <span className="flex-1">
                  {prettify(d.kind)}
                  {d.location_hint && (
                    <span className="text-slate-500"> — {d.location_hint}</span>
                  )}
                </span>
                <span className="text-slate-500 text-xs tabular-nums">
                  {(d.confidence * 100).toFixed(0)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {ga.conditionHints.length > 0 && (
        <div className="mt-5 pt-4 border-t border-ink-700/60">
          <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500 mb-2">Condition hints</div>
          <div className="flex flex-wrap gap-2">
            {ga.conditionHints.map((h, i) => (
              <span key={i} className="text-xs px-2.5 py-1 rounded-full bg-ink-800 border border-ink-600 text-slate-300">
                {prettify(h.hint)} <span className="text-slate-500">{(h.confidence * 100).toFixed(0)}%</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {ga.secondaryStructures.length > 0 && (
        <div className="mt-5 pt-4 border-t border-ink-700/60">
          <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500 mb-2">Attached additions</div>
          <div className="flex flex-wrap gap-2">
            {ga.secondaryStructures.map((s, i) => (
              <span key={i} className="text-xs px-2.5 py-1 rounded-full bg-ink-800 border border-ink-600 text-slate-300">
                {prettify(s.kind)}
              </span>
            ))}
          </div>
        </div>
      )}

      {ga.siteObstacles.length > 0 && (
        <div className="mt-5 pt-4 border-t border-ink-700/60">
          <div className="text-[10px] uppercase tracking-[0.16em] text-amber mb-2">Site obstacles</div>
          <div className="flex flex-wrap gap-2">
            {ga.siteObstacles.map((o, i) => (
              <span key={i} className="text-xs px-2.5 py-1 rounded-full bg-amber/5 border border-amber/30 text-amber">
                {prettify(o.kind)}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function StormHistoryCard({ storms, hail }: { storms: StormEvent[] | null; hail: HailEvent[] | null }) {
  if (storms == null && hail == null) {
    return (
      <section className="rounded-2xl border border-ink-700 bg-ink-900/80 p-5">
        <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400">Storm history</p>
        <p className="mt-2 text-sm text-slate-500">Loading…</p>
      </section>
    );
  }
  const stormCount = storms?.length ?? 0;
  const hailCount = hail?.length ?? 0;
  const maxHail =
    hail && hail.length > 0
      ? hail.reduce((m, h) => Math.max(m, h.maxSizeInches), 0)
      : null;
  return (
    <section className="rounded-2xl border border-ink-700 bg-ink-900/80 p-6">
      <p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 mb-4">Storm history</p>
      <div className="grid grid-cols-3 gap-4 mb-4">
        <Metric label="Reports (5yr)" value={stormCount.toString()} sub="hail / wind / tornado" />
        <Metric label="Hail events (3yr)" value={hailCount.toString()} sub="radar-derived" />
        <Metric label="Max hail" value={maxHail != null ? `${maxHail.toFixed(2)}″` : "—"} />
      </div>
      {(storms && storms.length > 0) || (hail && hail.length > 0) ? (
        <ul className="space-y-1.5 text-sm">
          {[
            ...(storms ?? []).slice(0, 4).map((s) => ({
              date: typeof s.event_begin_time === "string" ? s.event_begin_time.slice(0, 10) : "",
              label: s.event_type,
              mag: s.magnitude != null ? `${s.magnitude}${s.magnitude_type ?? ""}` : "—",
              dist: s.distance_miles,
            })),
            ...(hail ?? []).slice(0, 4).map((h) => ({
              date: h.date.slice(0, 10),
              label: "Hail (radar)",
              mag: `${h.maxSizeInches.toFixed(2)}″`,
              dist: h.distance_miles,
            })),
          ]
            .sort((a, b) => (a.date < b.date ? 1 : -1))
            .slice(0, 6)
            .map((e, i) => (
              <li key={i} className="flex gap-3 text-slate-200 tabular-nums">
                <span className="text-slate-400 w-24">{e.date}</span>
                <span className="flex-1">{e.label}</span>
                <span className="text-slate-400">{e.mag}</span>
                <span className="text-slate-500">{e.dist.toFixed(1)} mi</span>
              </li>
            ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-500">No severe weather reports in this radius / window.</p>
      )}
    </section>
  );
}

// ─── Right-rail panels ──────────────────────────────────────────────────

function LeadContextCard({ lead }: { lead: LeadRow }) {
  return (
    <section className="rounded-2xl border border-cy-400/30 bg-cy-500/[0.06] p-5 space-y-2">
      <p className="text-[10px] uppercase tracking-[0.22em] text-cy-300">Lead</p>
      {lead.name && <div className="text-sm text-slate-100">{lead.name}</div>}
      {lead.email && (
        <div className="text-xs text-slate-300">
          <a className="hover:text-slate-100" href={`mailto:${lead.email}`}>
            {lead.email}
          </a>
        </div>
      )}
      {lead.phone && (
        <div className="text-xs text-slate-300 tabular-nums">
          <a className="hover:text-slate-100" href={`tel:${lead.phone}`}>
            {lead.phone}
          </a>
        </div>
      )}
      <div className="pt-2 mt-2 border-t border-cy-400/20 space-y-1 text-[11px] text-slate-400">
        <div>Submitted: <span className="text-slate-200 tabular-nums">{new Date(lead.created_at).toLocaleString()}</span></div>
        {lead.source && <div>Source: <span className="text-slate-200">{lead.source}</span></div>}
        <div>
          Consent:{" "}
          <span className={lead.tcpa_consent ? "text-mint" : "text-rose"}>
            {lead.tcpa_consent ? "Email + SMS authorized" : "Not authorized"}
          </span>
        </div>
        {lead.tcpa_consent_at && (
          <div>Consent timestamp: <span className="text-slate-300 tabular-nums">{new Date(lead.tcpa_consent_at).toLocaleString()}</span></div>
        )}
      </div>
    </section>
  );
}

function RepInputs({
  material,
  setMaterial,
  manualPitchOn12,
  setManualPitchOn12,
  pitchAutoDetected,
  tearOff,
  setTearOff,
  laborMult,
  setLaborMult,
  materialMult,
  setMaterialMult,
}: {
  material: Material;
  setMaterial: (m: Material) => void;
  manualPitchOn12: number;
  setManualPitchOn12: (n: number) => void;
  pitchAutoDetected: number | null;
  tearOff: boolean;
  setTearOff: (b: boolean) => void;
  laborMult: number;
  setLaborMult: (n: number) => void;
  materialMult: number;
  setMaterialMult: (n: number) => void;
}) {
  return (
    <section className="rounded-2xl border border-ink-700 bg-ink-900/80 p-5 space-y-4">
      <p className="text-[10px] uppercase tracking-[0.22em] text-slate-400">Rep inputs</p>
      <div>
        <label className="block text-[10px] uppercase tracking-[0.16em] text-slate-500 mb-1.5">Material</label>
        <select
          value={material}
          onChange={(e) => setMaterial(e.target.value as Material)}
          className="w-full bg-ink-800 border border-ink-600 rounded-lg px-3 py-2 text-sm text-slate-100"
        >
          {Object.entries(MATERIAL_RATES).map(([key, m]) => (
            <option key={key} value={key}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-[10px] uppercase tracking-[0.16em] text-slate-500 mb-1.5">Pitch</label>
        {pitchAutoDetected != null ? (
          <div className="text-sm text-slate-200 tabular-nums">
            {pitchToOnTwelve(pitchAutoDetected)} · {pitchAutoDetected.toFixed(1)}°
            <span className="ml-2 text-[10px] uppercase tracking-[0.16em] text-cy-400">auto</span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={20}
              step={0.5}
              value={manualPitchOn12}
              onChange={(e) => setManualPitchOn12(parseFloat(e.target.value) || 5)}
              className="w-20 bg-ink-800 border border-ink-600 rounded-lg px-3 py-2 text-sm text-slate-100 tabular-nums"
            />
            <span className="text-sm text-slate-400">/ 12 (manual)</span>
          </div>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
        <input
          type="checkbox"
          checked={tearOff}
          onChange={(e) => setTearOff(e.target.checked)}
          className="w-4 h-4"
        />
        Include tear-off
      </label>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[10px] uppercase tracking-[0.16em] text-slate-500 mb-1">Labor ×</label>
          <input
            type="number"
            min={0.5}
            max={2.0}
            step={0.05}
            value={laborMult}
            onChange={(e) => setLaborMult(parseFloat(e.target.value) || 1.0)}
            className="w-full bg-ink-800 border border-ink-600 rounded-lg px-3 py-2 text-sm tabular-nums"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-[0.16em] text-slate-500 mb-1">Material ×</label>
          <input
            type="number"
            min={0.5}
            max={2.0}
            step={0.05}
            value={materialMult}
            onChange={(e) => setMaterialMult(parseFloat(e.target.value) || 1.0)}
            className="w-full bg-ink-800 border border-ink-600 rounded-lg px-3 py-2 text-sm tabular-nums"
          />
        </div>
      </div>
    </section>
  );
}

function NotesCard({ notes, setNotes }: { notes: string; setNotes: (s: string) => void }) {
  return (
    <section className="rounded-2xl border border-ink-700 bg-ink-900/80 p-5">
      <p className="text-[10px] uppercase tracking-[0.22em] text-slate-400 mb-2">Notes</p>
      <textarea
        placeholder="Site observations, customer requests, etc."
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={4}
        className="w-full bg-ink-800 border border-ink-600 rounded-lg px-3 py-2 text-sm resize-none"
      />
    </section>
  );
}

function PricingCard({
  pricing,
  sqft,
  pitchDeg,
}: {
  pricing: { low: number; mid: number; high: number; rateLabel: string };
  sqft: number | null;
  pitchDeg: number;
}) {
  return (
    <section className="rounded-2xl border border-cy-400/30 bg-cy-500/[0.06] p-5">
      <p className="text-[10px] uppercase tracking-[0.22em] text-cy-300">Headline price</p>
      <div className="mt-3 font-display text-3xl tabular-nums text-slate-100">
        ${pricing.mid.toLocaleString()}
      </div>
      <div className="mt-1 text-xs text-slate-400 tabular-nums">
        ${pricing.low.toLocaleString()} – ${pricing.high.toLocaleString()} range
      </div>
      <div className="mt-4 pt-4 border-t border-cy-400/20 text-xs text-slate-300 space-y-1">
        <div className="flex justify-between">
          <span className="text-slate-500">Material</span>
          <span>{pricing.rateLabel}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Sqft</span>
          <span className="tabular-nums">{sqft?.toLocaleString() ?? "—"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Pitch</span>
          <span className="tabular-nums">
            {pitchToOnTwelve(pitchDeg)} · {pitchDeg.toFixed(1)}°
          </span>
        </div>
      </div>
    </section>
  );
}
