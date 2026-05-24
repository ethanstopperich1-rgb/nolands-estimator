import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { rateLimit } from "@/lib/ratelimit";
import { checkPayloadSize, PAYLOAD_LIMITS } from "@/lib/payload-guard";
import { checkBotId } from "botid/server";
import { verifyRecaptcha } from "@/lib/recaptcha";
import { sendSms, toE164, twilioConfigured } from "@/lib/twilio";
import { attachLeadContext } from "@/lib/sms-conversation";
import { notifyOfficeOfNewLead } from "@/lib/lead-notifications";
import {
  LEAD_WEBHOOK_SCHEMA_VERSION,
  publishLeadEvent,
} from "@/lib/lead-webhook";
import { buildHomeownerShareUrl } from "@/lib/share-url";
import { resolveLangFromRequest, parseLang, t, type Lang } from "@/lib/i18n";
import {
  createServiceRoleClient,
  resolveOfficeBySlug,
  resolveOfficeIdBySlug,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";
import { validatePaintedPngBase64 } from "@/lib/validate-image";
import { sanitizeRoofV3Payload } from "@/lib/validate-roof-v3";
import { BRAND_CONFIG } from "@/lib/branding";
import { buildMarketingConsentText } from "@/lib/tcpa-consent";
import {
  hasMarketingConsent,
  isValidLeadPublicId,
  isValidOfficeSlug,
  normalizeOfficeSlug,
  isReasonableLength,
  ADDRESS_MAX_LEN,
  NAME_MAX_LEN,
  FREEFORM_MAX_LEN,
} from "@/lib/leads/validation";

export const runtime = "nodejs";
// Function needs to live long enough to (a) finish the synchronous lead
// insert + initial /api/dispatch-outbound forward, and (b) hold the
// short pre-dispatch delay inside waitUntil so the customer's phone
// doesn't ring the instant they submit.
//
// 30s gives the 3s delay PLUS realistic headroom for the downstream
// dispatch — LiveKit room creation + SIP outbound dispatch + Twilio
// trunk setup is routinely 5-12s on cold starts. The previous 15s
// budget left ~1s of headroom which would silently drop the call on
// any cold path, with no error surfaced to the customer.
export const maxDuration = 30;

interface LeadPayload {
  name: string;
  email: string;
  phone?: string;
  address: string;
  zip?: string;
  lat?: number;
  lng?: number;
  estimatedSqft?: number;
  material?: string;
  selectedAddOns?: string[];
  estimateLow?: number;
  estimateHigh?: number;
  source?: string;
  notes?: string;
  /** Office slug — drives multi-tenant routing in Supabase. Customer
   *  /quote sends this via the embed config / branded subdomain;
   *  defaults to "voxaris" (the seed office). */
  office?: string;
  /** Legacy single-consent boolean. Kept for back-compat with older
   *  client embeds; new code should send `marketingConsent` instead.
   *  When `tcpaConsent === true` and neither granular flag is set, we
   *  treat it as marketingConsent only (no voice). */
  tcpaConsent?: boolean;
  /** Granular consent 1 — required. Authorizes email + SMS intro.
   *  Without this we refuse to capture the lead. */
  marketingConsent?: boolean;
  /** Granular consent 2 — optional. Authorizes an outbound automated
   *  voice call. When false/missing, the server skips dispatch even if
   *  INTERNAL_DISPATCH_SECRET is configured and an estimate is present. */
  voiceConsent?: boolean;
  /** Exact disclosure text shown to the customer at consent time. We
   *  store this verbatim so we can prove what they agreed to if asked
   *  by FTC / a partner contractor in a compliance audit. */
  tcpaConsentText?: string;
  /** When the wizard already created a row (e.g. step-1 capture), pass
   *  the same public_id so the final submit updates instead of inserting
   *  a duplicate. Server requires the same email as the original row. */
  existingLeadPublicId?: string;
  /** reCAPTCHA v3 token minted on the client right before submit, with
   *  action="submit_lead". Verified server-side via
   *  `lib/recaptcha.ts` → Google siteverify. Score below the threshold
   *  (default 0.5) is rejected. Optional in dev / when
   *  RECAPTCHA_SECRET_KEY is unset; required + enforced in prod. */
  recaptchaToken?: string;
  /** Full customer-side Estimate snapshot. When set on the FINAL /quote
   *  submit (not the step-1 partial), the server writes a `proposals`
   *  row pinned to this lead so the rep dashboard's lead drawer surfaces
   *  the homeowner's saved estimate alongside any rep-generated ones.
   *  Loose `unknown` type because the full Estimate shape lives in
   *  types/estimate.ts and is broad — we validate the few fields we
   *  need (id, baseLow/High) at write time, store the rest as-is. */
  estimate?: unknown;
  /** Gemini V3 roof analysis from /estimate. Optional. When present,
   *  the server uploads `paintedImageBase64` to Supabase Storage
   *  (`painted-roofs` bucket, public read) and persists the remainder as
   *  `roof_v3_json` on the lead row, with `painted_url` injected so the
   *  dashboard can render the painted tile without a signed URL. */
  roofV3?: {
    paintedImageBase64?: string | null;
    [key: string]: unknown;
  };
}

/** @deprecated Import buildMarketingConsentText from lib/tcpa-consent */
export { buildMarketingConsentText as getMarketingConsentTextForOffice } from "@/lib/tcpa-consent";

/**
 * POST /api/leads
 * Receives a homeowner lead from the public /quote wizard. Persists to
 * Supabase when configured; always echoes a leadId. Optionally posts to
 * LEAD_WEBHOOK_URL for CRM intake.
 */
export async function POST(req: Request) {
  // Lead capture body includes an optional base64 painted PNG (capped
  // to 2 MB inside validatePaintedPngBase64). Cap the whole body at
  // 5 MB so an attacker can't pre-buffer a gigabyte before reaching
  // the PNG validator.
  const oversized = checkPayloadSize(req, { maxBytes: PAYLOAD_LIMITS.large });
  if (oversized) return oversized;
  const __rl = await rateLimit(req, "public");
  if (__rl) return __rl;

  // TCPA receipts must capture IP + UA at consent time (FTC guidance &
  // standard TCPA defense playbook). `x-forwarded-for` may be a comma-
  // separated proxy chain; the leftmost value is the client.
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const consentIp =
    xff.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    null;
  const consentUserAgent = req.headers.get("user-agent") || null;

  // Vercel BotID — paired with <BotIdClient> mounted on /quote + /embed.
  // The client widget runs a transparent JS challenge before the form
  // submits; the server side here verifies the signed verdict in the
  // request headers. Bots that bypass the widget (curl, script, etc.)
  // are rejected with 403. Human submissions are sub-50ms transparent.
  // No legit user sees a CAPTCHA.
  const verdict = await checkBotId();
  if ("isBot" in verdict && verdict.isBot && !verdict.isVerifiedBot) {
    return NextResponse.json(
      { error: "Bot detected" },
      { status: 403 },
    );
  }

  let body: LeadPayload;
  try {
    body = (await req.json()) as LeadPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // reCAPTCHA v3 — second bot signal, layered on top of BotID above.
  // Verifier soft-fails when RECAPTCHA_SECRET_KEY is unset (dev /
  // preview) and enforces the score threshold + action match when
  // configured. Score / action are logged on every call so we can tune
  // the threshold if false-positives start hurting conversion.
  const captcha = await verifyRecaptcha(
    body.recaptchaToken,
    "submit_lead",
    consentIp,
  );
  if (!captcha.ok) {
    console.warn("[leads] recaptcha_rejected", {
      reason: captcha.reason,
      score: captcha.score,
      action: captcha.action,
    });
    return NextResponse.json(
      { error: "captcha_failed" },
      { status: 403 },
    );
  }
  if (captcha.score !== null) {
    console.log("[leads] recaptcha_ok", {
      score: captcha.score,
      action: captcha.action,
    });
  }

  if (!body.name?.trim() || !body.email?.trim() || !body.address?.trim()) {
    return NextResponse.json(
      { error: "name, email and address are required" },
      { status: 400 },
    );
  }

  // Length caps — defense against storage / log bloat AND amplifies the
  // prompt-injection defense in lib/sanitize-prompt-input.ts (the
  // sanitizer truncates too, but rejecting at the boundary is cheaper
  // and surfaces a clearer error to a buggy caller). The notes / source
  // fields also accept freeform text.
  if (!isReasonableLength(body.name, NAME_MAX_LEN)) {
    return NextResponse.json(
      { error: "name_too_long", max_length: NAME_MAX_LEN },
      { status: 400 },
    );
  }
  if (!isReasonableLength(body.address, ADDRESS_MAX_LEN)) {
    return NextResponse.json(
      { error: "address_too_long", max_length: ADDRESS_MAX_LEN },
      { status: 400 },
    );
  }
  if (body.notes != null && !isReasonableLength(body.notes, FREEFORM_MAX_LEN)) {
    return NextResponse.json(
      { error: "notes_too_long", max_length: FREEFORM_MAX_LEN },
      { status: 400 },
    );
  }

  // TCPA consent enforcement — server-side gate. The client form gates
  // the submit button via React state, but a direct POST could bypass
  // that check. We REQUIRE the marketing consent before any SMS or
  // email outreach fires. Voice consent is granular and OPTIONAL: it
  // only authorizes the outbound automated voice call, which is gated
  // separately below.
  const marketingConsent = hasMarketingConsent(body);
  const voiceConsent = body.voiceConsent === true;
  if (!marketingConsent) {
    return NextResponse.json(
      {
        error: "marketing_consent_required",
        message:
          "Marketing consent is required before submitting contact info. " +
          "Check the consent box and resubmit.",
      },
      { status: 400 },
    );
  }

  const submittedAt = new Date().toISOString();
  const emailNorm = body.email.trim().toLowerCase();
  // Tenancy — every lead MUST land in a specific business. Allow the
  // caller to omit `office` for back-compat (defaults to "nolands", the
  // only live customer today) but VALIDATE the slug shape + active-
  // status against the offices table before we accept it. Unknown /
  // inactive slugs get rejected so a misconfigured embed snippet
  // doesn't silently drop leads into the wrong office.
  const rawOfficeSlug = normalizeOfficeSlug(body.office);
  if (!isValidOfficeSlug(rawOfficeSlug)) {
    return NextResponse.json(
      { error: "invalid_office", message: "office must be a slug like 'nolands'." },
      { status: 400 },
    );
  }
  if (supabaseServiceRoleConfigured()) {
    const validatedId = await resolveOfficeIdBySlug(rawOfficeSlug);
    if (!validatedId) {
      return NextResponse.json(
        {
          error: "unknown_office",
          message: `No active business is registered for the slug '${rawOfficeSlug}'.`,
        },
        { status: 400 },
      );
    }
  }
  const officeSlug = rawOfficeSlug;

  // Language preference for the bilingual customer journey. Client
  // can pass `preferredLanguage` in the body (set by the toggle on
  // /); we fall back to request inference (?lang=es query, vx-lang
  // cookie, Accept-Language) for older clients or direct API calls.
  const preferredLanguage: Lang =
    // Body wins — the customer toggled it explicitly on the page.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parseLang((body as any)?.preferredLanguage) ??
    resolveLangFromRequest(req);

  let leadId = `lead_${crypto.randomUUID().replace(/-/g, "")}`;
  // Dedup linkage. When a homeowner submits multiple times within
  // the dedup window (30d, same office_id, matched on phone OR
  // email), the new row's parent_lead_id points at the canonical
  // first submission. We then SUPPRESS all downstream side effects
  // (SMS confirm, rep alert, Sydney dispatch, lead webhook) — those
  // already fired on the parent. We also REUSE the parent's painted
  // overlay so we never burn a second Gemini Pro Image call for the
  // same roof. See lib/leads/dedup.ts for matching rules.
  let dedupMatch: import("@/lib/leads/dedup").DuplicateMatch | null = null;
  let isLeadUpdate = false;

  if (supabaseServiceRoleConfigured() && isValidLeadPublicId(body.existingLeadPublicId)) {
    const oid = await resolveOfficeIdBySlug(officeSlug);
    if (oid) {
      const sb = createServiceRoleClient();
      const { data: prior } = await sb
        .from("leads")
        .select("id, email, public_id")
        .eq("public_id", body.existingLeadPublicId.trim())
        .eq("office_id", oid)
        .maybeSingle();
      if (prior && prior.email === emailNorm) {
        leadId = prior.public_id;
        isLeadUpdate = true;
      }
    }
  }

  // ─── Supabase persistence ──────────────────────────────────────────
  // Primary destination for the lead. When Supabase env vars aren't
  // set (dev / preview), this silently no-ops and the legacy webhook
  // flow below still fires. office slug → office_id lookup is cached
  // 1h in resolveOfficeIdBySlug.
  // Office-aware branding — used by SMS intro + the voice-agent persona.
  // We resolve once here so the SMS template + dispatch payload can both
  // address the customer as the actual office name ("Nolands Roofing"
  // not "Voxaris").
  const officeBranding = supabaseServiceRoleConfigured()
    ? await resolveOfficeBySlug(officeSlug)
    : null;
  const marketingConsentText = buildMarketingConsentText(
    officeBranding?.displayName ?? BRAND_CONFIG.companyName,
  );

  if (supabaseServiceRoleConfigured()) {
    try {
      // Re-resolve office_id at write time (not just from the earlier
      // line-218 validation). resolveOfficeIdBySlug is cached 1h, but
      // the cache key flips when the office is deactivated, so this
      // call returns null if the office went away between the request
      // start and now. The "no insert happens" path below is safe by
      // design — we'd rather drop a lead than write it to a stale or
      // null office_id. Defense-in-depth on the multi-tenant invariant
      // documented in lib/supabase.ts.
      const officeId = officeBranding?.id ?? (await resolveOfficeIdBySlug(officeSlug));
      if (!officeId) {
        console.warn(`[leads] no active office for slug='${officeSlug}' at insert time — lead drop`);
      } else {
        const supabase = createServiceRoleClient();

        // ─── Dedup probe ───────────────────────────────────────────
        // Only check on fresh inserts. Lead UPDATES are by definition
        // the same lead row (final submit of a multi-step wizard).
        if (!isLeadUpdate) {
          const { findDuplicateLead } = await import("@/lib/leads/dedup");
          dedupMatch = await findDuplicateLead({
            supabase,
            officeId,
            phone: body.phone,
            email: emailNorm,
          });
          if (dedupMatch) {
            console.log(
              "[leads] duplicate detected — linking + suppressing notifications",
              {
                newPublicId: leadId,
                parentPublicId: dedupMatch.parentPublicId,
                matchedOn: dedupMatch.matchedOn,
              },
            );
          }
        }

        // ─── V3 painted-image upload ───────────────────────────────
        // If the caller (today: /estimate) sent a Gemini V3 roof
        // payload, peel the base64 PNG off, upload it to the public
        // `painted-roofs` bucket, and replace it with a CDN URL in the
        // JSON we persist on the row. Keeps the lead row small (jsonb
        // pages poorly when it holds ~700 KB of base64) and lets the
        // dashboard <img src="..."> straight from Storage.
        // Use the Supabase `Json` type so the inferred shape on `row`
        // stays compatible with the leads Insert/Update generics.
        let roofV3Json:
          | import("@/types/supabase").Json
          | null = null;
        if (body.roofV3 && typeof body.roofV3 === "object") {
          const { paintedImageBase64, ...rest } = body.roofV3;
          let paintedUrl: string | null = null;
          if (typeof paintedImageBase64 === "string" && paintedImageBase64.length > 0) {
            // PNG magic-bytes + 2 MB size cap before write. Storage is
            // public-served, so this is the gate that stops a hostile
            // client from planting arbitrary content under our domain.
            const validated = validatePaintedPngBase64(paintedImageBase64);
            if (!validated.ok) {
              console.warn(
                `[leads] painted image rejected: ${validated.reason}`,
              );
            } else {
              try {
                const objectKey = `${leadId}.png`;
                const up = await supabase.storage
                  .from("painted-roofs")
                  .upload(objectKey, validated.bytes, {
                    contentType: "image/png",
                    upsert: true,
                  });
                if (up.error) {
                  console.error("[leads] painted upload failed:", up.error.message);
                } else {
                  // Mint via the shared helper so all 3 write paths
                  // (here, /api/gemini-roof, /api/leads/[id]/roof-v3)
                  // produce the SAME url shape. Survives the bucket
                  // flipping public→private. See lib/painted-url.ts
                  // for the parity invariant.
                  const { mintPaintedUrl } = await import("@/lib/painted-url");
                  const minted = await mintPaintedUrl(supabase, leadId);
                  paintedUrl = minted.url;
                }
              } catch (e) {
                console.error("[leads] painted upload threw:", e);
              }
            }
          }
          // Allow-list sanitize the client payload — unknown fields are
          // discarded so no future code path can ever read attacker-
          // controlled JSON off the lead row.
          const { json: sanitizedJson } = sanitizeRoofV3Payload(rest);
          roofV3Json = {
            ...(sanitizedJson as Record<string, unknown>),
            painted_url: paintedUrl,
          } as import("@/types/supabase").Json;
        }

        // ─── Dedup photo reuse ─────────────────────────────────────
        // If this is a duplicate of an existing lead, ignore the
        // freshly-uploaded V3 payload (if any) and reuse the parent's
        // persisted roof_v3_json instead. Two wins:
        //   1. Painted overlay matches what the homeowner already saw
        //      on the parent submission — true parity (per the
        //      painted-overlay parity invariant in AGENTS.md)
        //   2. Zero Gemini cost — the upload above already happened
        //      and was uploaded to Storage under the NEW lead's
        //      objectKey, but Storage will see it as a wasted write
        //      and the new row points at the SAME bytes via the
        //      mintPaintedUrl helper. (Future optimization: dedup
        //      at upload time too. For now the savings is in not
        //      re-running the V3 pipeline, which costs ~$0.08/call.)
        if (dedupMatch && dedupMatch.parentRoofV3Json) {
          roofV3Json = dedupMatch.parentRoofV3Json as import("@/types/supabase").Json;
        }

        const row = {
          name: body.name.trim(),
          email: emailNorm,
          phone: body.phone?.trim() || null,
          address: body.address.trim(),
          zip: body.zip ?? null,
          lat: body.lat ?? null,
          lng: body.lng ?? null,
          estimated_sqft: body.estimatedSqft ?? null,
          material: body.material ?? null,
          selected_add_ons: body.selectedAddOns ?? null,
          estimate_low: body.estimateLow ?? null,
          estimate_high: body.estimateHigh ?? null,
          source: body.source ?? null,
          notes: body.notes ?? null,
          tcpa_consent: true,
          tcpa_consent_at: submittedAt,
          tcpa_consent_text: marketingConsentText,
          ...(roofV3Json ? { roof_v3_json: roofV3Json } : {}),
          // Dedup linkage — null on canonical first submissions, set
          // on subsequent dupes within the dedup window. Migration
          // 0008_lead_dedup adds this column; if the migration hasn't
          // been applied yet, Supabase will reject the insert and the
          // catch block above will log it. After that, dedup degrades
          // gracefully via lib/leads/dedup.ts.
          ...(dedupMatch ? { parent_lead_id: dedupMatch.parentId } : {}),
          // Language preference — drives downstream SMS / Sydney /
          // share-page localization. Migration 0009 adds the column.
          // Default 'en' if migration not yet applied (Supabase
          // accepts the field with default).
          preferred_language: preferredLanguage,
        };

        if (isLeadUpdate) {
          const { error } = await supabase
            .from("leads")
            .update(row)
            .eq("public_id", leadId)
            .eq("office_id", officeId);
          if (error) {
            console.error("[leads] supabase update failed:", error.message);
          }
        } else {
          const { data, error } = await supabase
            .from("leads")
            .insert({
              office_id: officeId,
              public_id: leadId,
              ...row,
            })
            .select("id")
            .single();
          if (error) {
            console.error("[leads] supabase insert failed:", error.message);
          } else if (data) {
            // Audit-trail row in consents — append-only, regulator-grade
            // receipt of what disclosure the customer agreed to.
            await supabase.from("consents").insert({
              office_id: officeId,
              lead_id: data.id,
              // Matches the documented enum in migrations/0001:
              // 'tcpa_marketing' | 'call_recording' | 'sms' | 'email_marketing'.
              consent_type: "tcpa_marketing",
              disclosure_text: marketingConsentText,
              email: emailNorm,
              phone: body.phone?.trim() || null,
              ip_address: consentIp,
              user_agent: consentUserAgent,
            });
            // Separate voice-consent receipt — only written when the
            // customer explicitly opted in to the outbound automated
            // voice call. Stored under `call_recording` to match the
            // existing consents enum; the disclosure_text disambiguates.
            if (voiceConsent) {
              await supabase.from("consents").insert({
                office_id: officeId,
                lead_id: data.id,
                consent_type: "call_recording",
                disclosure_text:
                  "Customer authorized an automated outbound voice intro call from " +
                  (officeBranding?.displayName ?? "the assigned business") +
                  " at the phone number provided. Recording may apply. Reply STOP to opt out.",
                email: emailNorm,
                phone: body.phone?.trim() || null,
                ip_address: consentIp,
                user_agent: consentUserAgent,
              });
            }

            // Companion proposals row from V3 submissions — when the
            // /estimate customer sent a roofV3 payload, mirror it
            // into proposals so "Saved estimates" + the proposal page
            // both work. The snapshot carries the full V3 shape with a
            // `kind: "roof_v3"` discriminator the proposal renderer
            // uses to decide between the legacy and V3 layouts.
            if (roofV3Json) {
              const propPubId = `prop_${leadId.replace(/^lead_/, "")}_v3`;
              // Prefer the customer-visible price the client already
              // computed (body.estimateLow / body.estimateHigh). When
              // not on the request, leave total_low/high NULL on the
              // proposal row rather than recomputing with a separate
              // formula. The previous backend $6.50–$11.50/sqft band
              // drifted from the customer-visible number, putting the
              // rep on unfamiliar ground when they opened the lead.
              const propLow =
                typeof body.estimateLow === "number"
                  ? Math.round(body.estimateLow)
                  : null;
              const propHigh =
                typeof body.estimateHigh === "number"
                  ? Math.round(body.estimateHigh)
                  : null;
              const { error: propV3Err } = await supabase
                .from("proposals")
                .upsert(
                  {
                    office_id: officeId,
                    lead_id: data.id,
                    public_id: propPubId,
                    snapshot: {
                      kind: "roof_v3",
                      lead_public_id: leadId,
                      address: body.address.trim(),
                      customer: {
                        name: body.name.trim(),
                        email: emailNorm,
                        phone: body.phone?.trim() || null,
                      },
                      roof_v3: roofV3Json,
                    } as unknown as import("@/types/supabase").Json,
                    total_low: propLow,
                    total_high: propHigh,
                    generated_by: null,
                  },
                  { onConflict: "public_id" },
                );
              if (propV3Err) {
                console.error(
                  "[leads] V3 proposal-attach upsert failed:",
                  propV3Err.message,
                );
              }
            }

            if (body.estimate && typeof body.estimate === "object") {
              const est = body.estimate as Record<string, unknown>;
              const estId = typeof est.id === "string" ? est.id : null;
              // v2 snapshots have version: 2 and totals under priced.totalLow /
              // priced.totalHigh. v1 keeps baseLow / baseHigh at the top. Either
              // way the proposals.total_low / total_high columns are integer,
              // so we round.
              let baseLow: number | null = null;
              let baseHigh: number | null = null;
              if (est.version === 2 && typeof est.priced === "object" && est.priced) {
                const priced = est.priced as Record<string, unknown>;
                if (typeof priced.totalLow === "number") {
                  baseLow = Math.round(priced.totalLow);
                }
                if (typeof priced.totalHigh === "number") {
                  baseHigh = Math.round(priced.totalHigh);
                }
              } else {
                if (typeof est.baseLow === "number") baseLow = est.baseLow;
                if (typeof est.baseHigh === "number") baseHigh = est.baseHigh;
              }
              if (estId && /^[a-z0-9_-]{8,64}$/i.test(estId)) {
                // generated_by is uuid in prod (FK→users.id), so we leave it
                // NULL for customer self-served quotes. The distinguishing
                // signal lives in snapshot.staff = "Customer · self-served"
                // (set in app/quote/page.tsx where customerEstimate is built).
                const { error: propErr } = await supabase
                  .from("proposals")
                  .upsert(
                    {
                      office_id: officeId,
                      lead_id: data.id,
                      public_id: estId,
                      snapshot: JSON.parse(JSON.stringify(body.estimate)),
                      total_low: baseLow,
                      total_high: baseHigh,
                      generated_by: null,
                    },
                    { onConflict: "public_id" },
                  );
                if (propErr) {
                  console.error(
                    "[leads] proposal-attach insert failed:",
                    propErr.message,
                  );
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.error("[leads] supabase block threw:", err);
    }
  }

  // Optional CRM/Slack/Email webhook — keep silent failures on the customer
  // path. We log on the server but never fail the lead capture itself.
  const hookUrl = process.env.LEAD_WEBHOOK_URL;
  if (hookUrl) {
    try {
      await fetch(hookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadId,
          submittedAt,
          ...body,
          email: emailNorm,
          // Always echo back the verbatim consent text we BELIEVE the
          // customer saw, plus the server-side timestamp. The body's
          // tcpaConsentText is client-supplied and could be spoofed;
          // ours is the canonical receipt.
          tcpaConsent: true,
          tcpaConsentText: marketingConsentText,
          tcpaConsentAt: submittedAt,
        }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (err) {
      console.error("[leads] webhook failed:", err);
    }
  }

  // Audit log — every successful consent gets recorded. Vercel logs are
  // a SECONDARY destination with limited retention + access controls, so
  // we deliberately do NOT write raw PII here. Instead we log:
  //   - leadId (server-issued, opaque)
  //   - submittedAt (server timestamp)
  //   - emailHash + phoneHash (first 12 chars of SHA-256 — enough for
  //     correlation across log lines without leaking the underlying
  //     identifier)
  //   - canonical consent text (constant — for proving what the user saw)
  //
  // The CRM/Slack webhook above (and Supabase persistence when wired)
  // is the PRIMARY destination for raw PII — that path has proper
  // retention + access controls. The webhook payload still carries the
  // full email + phone unchanged.
  const hashFragment = (v: string): string =>
    createHash("sha256").update(v).digest("hex").slice(0, 12);
  console.log(
    JSON.stringify({
      tag: "tcpa-consent",
      leadId,
      submittedAt,
      emailHash: hashFragment(emailNorm),
      phoneHash: body.phone ? hashFragment(body.phone.replace(/\D/g, "")) : null,
      consentText: marketingConsentText,
    }),
  );

  // SMS confirmation. Fire-and-forget — Twilio failures must NEVER
  // break the lead capture (the lead is still in the webhook + UI
  // confirmation). We also seed conversation memory so when the
  // customer texts back, the SMS bot already knows their estimate.
  const phoneE164 = toE164(body.phone);
  // Customer-SMS provider gate. Default: Voxaris sends via Twilio.
  // Opt-out: an office that uses Podium / HighLevel / Birdeye / etc.
  // for two-way customer messaging sets CUSTOMER_SMS_DISABLED=true
  // (or, in a future migration, `offices.customer_sms_disabled=true`).
  // When disabled, the customer confirmation is delivered through the
  // contractor's existing platform via the lead webhook below; we
  // still seed sms-conversation memory so if the customer texts our
  // number directly we have context.
  const customerSmsDisabled =
    (process.env.CUSTOMER_SMS_DISABLED ?? "").toLowerCase() === "true";
  if (phoneE164 && twilioConfigured() && !isLeadUpdate && !customerSmsDisabled && !dedupMatch) {
    const firstName = body.name.split(/\s+/)[0];
    // Office-aware SMS intro. Falls back to "Noland's Roofing" if the
    // office row didn't resolve (dev / preview without Supabase). This
    // fork is Noland's-only so the fallback names the correct sender,
    // not the upstream platform vendor.
    const officeName = officeBranding?.displayName ?? "Noland's Roofing";
    // Default agent display name. "Sydney" is the LiveKit worker
    // codename in voxaris-pitch; the homeowner-facing name was
    // confirmed as "Sarah" on the Noland's onboarding form. When
    // future white-label deploys ship under this codebase, set
    // offices.livekit_agent_name to the contractor's preferred
    // display name. Stays in lockstep with lib/agent-config.ts
    // AGENT_DISPLAY_NAME so SMS + result-page copy never drift.
    const agentName = officeBranding?.livekitAgentName ?? "Sarah";
    const estimateLine =
      body.estimateLow && body.estimateHigh
        ? t("sms.estimate_range", preferredLanguage, {
            low: body.estimateLow.toLocaleString(),
            high: body.estimateHigh.toLocaleString(),
          })
        : "";
    // Homeowner-share URL — bookmark/share to spouse. Server-
    // rendered from persisted V3 blob, no fresh pipeline call. OG
    // + Twitter cards render it as a rich preview.
    const shareOrigin = new URL(req.url).origin;
    const shareUrl = buildHomeownerShareUrl(leadId, shareOrigin);
    // Localized via lib/i18n.ts — Spanish-preferring homeowners get
    // the Spanish confirmation including the FCC-compliant
    // "asistente de voz AI" disclosure. EN/ES toggled by the
    // customer page; persisted on the lead row.
    const smsBody = t("sms.confirmation", preferredLanguage, {
      firstName,
      agentName,
      officeName,
      address: body.address,
      estimateLine,
      shareUrl,
    });

    // Run both writes in parallel and don't await — keep the API
    // response fast.
    void Promise.all([
      // FROM the office's own Twilio number — homeowner sees the
      // contractor's brand, not Voxaris. The +1 888 786 9134 stays
      // reserved for Voxaris→contractor sales / internal testing.
      sendSms({
        to: phoneE164,
        body: smsBody,
        from: officeBranding?.twilioNumber ?? undefined,
      })
        .then((r) =>
          console.log("[leads] sent confirmation SMS", {
            leadId,
            sid: r.sid,
            status: r.status,
          }),
        )
        .catch((err) =>
          console.error("[leads] SMS send failed:", err),
        ),
      attachLeadContext({
        phone: phoneE164,
        lead: {
          leadId,
          name: body.name,
          email: body.email,
          address: body.address,
          estimateLow: body.estimateLow,
          estimateHigh: body.estimateHigh,
          material: body.material,
          estimatedSqft: body.estimatedSqft,
          selectedAddOns: body.selectedAddOns,
          submittedAt,
        },
      }).catch((err) =>
        console.error("[leads] attachLeadContext failed:", err),
      ),
    ]);
  } else if (phoneE164 && twilioConfigured() && isLeadUpdate) {
    void attachLeadContext({
      phone: phoneE164,
      lead: {
        leadId,
        name: body.name,
        email: body.email,
        address: body.address,
        estimateLow: body.estimateLow,
        estimateHigh: body.estimateHigh,
        material: body.material,
        estimatedSqft: body.estimatedSqft,
        selectedAddOns: body.selectedAddOns,
        submittedAt,
      },
    }).catch((err) =>
      console.error("[leads] attachLeadContext failed:", err),
    );
  }

  // ─── Rep / office new-lead SMS ───────────────────────────────────────
  // Speed-of-notice ping to the contractor's rep line (or the global
  // LEAD_NOTIFY_PHONE for Voxaris-internal flow before any office is
  // wired). Fires only when an estimate is present — that's the final-
  // submit moment, identical to the dispatch gate. Soft-fails on every
  // path; never blocks the lead capture response. Independent of the
  // TCPA voice-consent gate because this is an INTERNAL operator
  // notification, not consumer marketing.
  // Suppress on dupes — the parent submission already pinged the rep
  // + fired the lead webhook. Re-pinging on every dupe trains reps to
  // ignore the alerts entirely.
  const hasEstimateForNotify =
    typeof body.estimateLow === "number" && typeof body.estimateHigh === "number";
  if (hasEstimateForNotify && !dedupMatch) {
    const dashboardOrigin = new URL(req.url).origin;
    void notifyOfficeOfNewLead({
      office: officeBranding,
      lead: {
        leadPublicId: leadId,
        name: body.name,
        address: body.address,
        phone: body.phone,
        estimateLow: body.estimateLow,
        estimateHigh: body.estimateHigh,
        material: body.material,
        sqft: body.estimatedSqft,
        source: body.source,
      },
      dashboardOrigin,
    });

    // ─── Provider-agnostic lead webhook ──────────────────────────────
    // Fires alongside (NOT instead of) the rep SMS. Lets each office
    // pipe leads into Podium / HighLevel / Birdeye / Zapier / whatever
    // platform they already use for two-way customer messaging. The
    // payload schema is versioned (LEAD_WEBHOOK_SCHEMA_VERSION) and
    // HMAC-signed so the receiver can trust it. Soft-fails on every
    // path — webhook outage never blocks lead capture.
    void publishLeadEvent({
      office: officeBranding,
      event: {
        schema_version: LEAD_WEBHOOK_SCHEMA_VERSION,
        event: "new_lead",
        occurred_at: new Date().toISOString(),
        office: {
          id: officeBranding?.id ?? "",
          slug: officeBranding?.slug ?? "",
          display_name: officeBranding?.displayName ?? "Voxaris",
        },
        lead: {
          public_id: leadId,
          name: body.name,
          email: body.email ?? null,
          phone_raw: body.phone ?? null,
          phone_e164: phoneE164,
          address: body.address,
          estimate_low: body.estimateLow ?? null,
          estimate_high: body.estimateHigh ?? null,
          material: body.material ?? null,
          estimated_sqft: body.estimatedSqft ?? null,
          source: body.source ?? null,
          report_url: `${dashboardOrigin}/dashboard/leads/${leadId}`,
        },
      },
    });
  }

  // ─── Sydney outbound dispatch ────────────────────────────────────────
  // After the lead is captured, immediately dispatch Sydney to OUTBOUND
  // call the customer's phone. Wrapped in `waitUntil` so Vercel keeps
  // the serverless function instance alive until the HTTP round-trip
  // to /api/dispatch-outbound finishes. Plain fire-and-forget
  // (`void fetch(...)`) was DROPPING dispatches: Vercel freezes the
  // function as soon as we `return NextResponse.json(...)`, killing
  // the in-flight fetch before it lands. waitUntil is the canonical fix.
  //
  // GATE: dispatch ONLY when we have an estimate range. The /quote wizard
  // posts TWICE — once at step 1 (hero form, no estimate) to capture the
  // lead early, then again at final submit (full estimate). Calling on
  // step 1 is the wrong moment (no estimate to talk about, wizard might
  // not even complete) AND the previous `!isLeadUpdate` gate was the
  // exact wrong shape — it dispatched on step 1 and SKIPPED the final
  // submit, which is the moment the customer actually expects engagement.
  // Now we dispatch when an estimate is present, which is exclusively the
  // final-submit path, regardless of whether the row is an insert or an
  // update of an earlier step-1 capture.
  const hasEstimate =
    typeof body.estimateLow === "number" && typeof body.estimateHigh === "number";
  // VOICE-CONSENT GATE — strict. The dispatch only fires when the
  // customer explicitly set `voiceConsent: true`. The prior back-compat
  // fallback (allow dispatch when BOTH voiceConsent and
  // marketingConsent were undefined) was unsafe: any client that
  // simply omitted both fields — bots included — could trigger an
  // autodialed voice call. TCPA's "prior express written consent"
  // standard requires an affirmative opt-in; omission cannot satisfy
  // it. All current customer flows (`/` post-estimate consent
  // sub-route, /quote, rep-initiated dispatch) explicitly set
  // voiceConsent, so removing the omission path doesn't regress
  // legitimate traffic — it only closes the bot loophole.
  const dispatchAllowed = voiceConsent === true;
  // Suppress on dupes — Sydney already called this homeowner on the
  // parent submission. Re-calling within the dedup window is the
  // exact "creepy auto-dialer" UX TCPA was meant to prevent.
  if (
    phoneE164 &&
    process.env.INTERNAL_DISPATCH_SECRET &&
    hasEstimate &&
    dispatchAllowed &&
    !dedupMatch
  ) {
    const origin = new URL(req.url).origin;
    const dispatchSecret = process.env.INTERNAL_DISPATCH_SECRET;
    // Hold the dispatch for a beat so the customer has a moment to
    // dismiss the form and read the confirmation card before their
    // phone rings. 3s keeps the call effectively "instant" while still
    // letting the submit animation settle — long pauses were making the
    // demo feel broken.
    const DISPATCH_DELAY_MS = 3_000;
    console.log("[leads] queuing outbound dispatch", {
      leadId,
      phoneE164,
      isLeadUpdate,
      source: body.source ?? null,
      delayMs: DISPATCH_DELAY_MS,
    });
    waitUntil(
      new Promise<void>((resolve) =>
        setTimeout(() => resolve(), DISPATCH_DELAY_MS),
      )
        .then(() =>
          fetch(`${origin}/api/dispatch-outbound`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-dispatch-secret": dispatchSecret,
            },
            body: JSON.stringify({
              leadId,
              name: body.name,
              phone: phoneE164,
              address: body.address,
              estimateLow: body.estimateLow,
              estimateHigh: body.estimateHigh,
              material: body.material,
              // Tenancy — pass the SAME office that we just persisted the
              // lead row under. Sydney's outbound script reads this from
              // ctx.job.metadata so the caller hears "Sydney with <that
              // office's company name>." Backend tenancy and voice brand
              // are now unified — one office routes the entire flow.
              office: officeSlug,
              estimatedSqft: body.estimatedSqft,
              // Bilingual journey — homeowner's EN/ES choice from the
              // page toggle. Sydney's worker reads
              // ctx.job.metadata.preferredLanguage and branches the
              // opener + selects a Spanish TTS voice. FCC AI-voice
              // disclosure compliance is satisfied in the language of
              // the consent capture.
              preferredLanguage,
            }),
          }),
        )
        .then(async (r) => {
          const text = await r.text().catch(() => "");
          if (!r.ok) {
            console.error(
              "[leads] outbound dispatch non-OK:",
              r.status,
              text,
            );
          } else {
            console.log("[leads] outbound dispatched:", { leadId, body: text });
          }
        })
        .catch((err) =>
          console.error("[leads] outbound dispatch failed:", err),
        ),
    );
  } else if (phoneE164 && hasEstimate && !process.env.INTERNAL_DISPATCH_SECRET) {
    console.warn(
      "[leads] outbound dispatch SKIPPED — INTERNAL_DISPATCH_SECRET not set",
    );
  } else if (phoneE164 && !hasEstimate) {
    console.log(
      "[leads] outbound dispatch HELD — no estimate yet (step 1 capture)",
      { leadId, source: body.source ?? null },
    );
  }

  // Operator notification — fire-and-forget ping to the owner's phone
  // via sent.dm. Out-of-band channel so Ethan gets a buzz the moment
  // a lead lands, without watching dashboards. No-ops cleanly when
  // SENT_API_KEY / OWNER_PHONE_E164 / SENT_DM_OPS_TEMPLATE_ID are
  // unset. NOT customer-facing — strictly operator-to-operator,
  // outside the TCPA marketing channel. Dedup matches stay silent
  // (already-known lead = no ping needed).
  if (!dedupMatch) {
    void import("@/lib/sentdm").then(({ notifyOwner }) =>
      notifyOwner(
        `New lead · ${body.name.split(/\s+/)[0]} · ${body.address.split(",")[0]}`,
        { tag: "lead", idempotencyKey: `lead-${leadId}` },
      ),
    ).catch(() => {
      // Notification failure must never break the customer response.
    });
  }

  // When the submission was a dedup match, surface the parent's
  // publicId so the customer page can redirect/inline the existing
  // report instead of treating this as a brand-new lead.
  // Notification suppression already happened above; this is purely
  // a client hint for UX (show "we've already got your request"
  // message linking to /r/[parentPublicId]).
  return NextResponse.json({
    leadId,
    submittedAt,
    message: dedupMatch
      ? "We already have your request — your roof report is ready."
      : "Thanks — a Noland's Roofing rep will contact you within 1 business hour.",
    ...(dedupMatch
      ? {
          isDuplicate: true,
          parentPublicId: dedupMatch.parentPublicId,
          matchedOn: dedupMatch.matchedOn,
        }
      : {}),
  });
}
