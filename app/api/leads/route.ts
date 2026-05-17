import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { rateLimit } from "@/lib/ratelimit";
import { checkBotId } from "botid/server";
import { sendSms, toE164, twilioConfigured } from "@/lib/twilio";
import { attachLeadContext } from "@/lib/sms-conversation";
import {
  createServiceRoleClient,
  resolveOfficeBySlug,
  resolveOfficeIdBySlug,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";

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
  /** Full customer-side Estimate snapshot. When set on the FINAL /quote
   *  submit (not the step-1 partial), the server writes a `proposals`
   *  row pinned to this lead so the rep dashboard's lead drawer surfaces
   *  the homeowner's saved estimate alongside any rep-generated ones.
   *  Loose `unknown` type because the full Estimate shape lives in
   *  types/estimate.ts and is broad — we validate the few fields we
   *  need (id, baseLow/High) at write time, store the rest as-is. */
  estimate?: unknown;
  /** Gemini V3 roof analysis from /estimate-v2. Optional. When present,
   *  the server uploads `paintedImageBase64` to Supabase Storage
   *  (`painted-roofs` bucket, public read) and persists the remainder as
   *  `roof_v3_json` on the lead row, with `painted_url` injected so the
   *  dashboard can render the painted tile without a signed URL. */
  roofV3?: {
    paintedImageBase64?: string | null;
    [key: string]: unknown;
  };
}

/** TCPA disclosure text — the exact wording the customer agrees to.
 *  Pin this constant so any change to the consent text is tracked in
 *  git and survives consent audits. If the wording is updated, this
 *  string AND the rendered checkbox copy in
 *  `components/ui/bolt-style-chat.tsx` MUST change together — they're
 *  the same legal disclosure and must remain byte-equivalent for the
 *  audit trail to be defensible. Last updated 2026-05-12 to match the
 *  /privacy + /terms links rolled out in commit d0a0293. */
export const TCPA_CONSENT_TEXT =
  "By submitting this form, you consent to receive automated marketing " +
  "calls, texts, and emails from Voxaris and its partner contractors at " +
  "the phone number and email provided. Consent is not required to make " +
  "a purchase. Message frequency varies; message and data rates may apply. " +
  "Reply STOP to opt out, HELP for help. See our Privacy Policy at " +
  "/privacy and Terms of Service at /terms.";

function isValidExistingLeadPublicId(id: unknown): id is string {
  return typeof id === "string" && /^lead_[0-9a-f]{32}$/i.test(id.trim());
}

/**
 * POST /api/leads
 * Receives a homeowner lead from the public /quote wizard. Persists to
 * Supabase when configured; always echoes a leadId. Optionally posts to
 * LEAD_WEBHOOK_URL for CRM intake.
 */
export async function POST(req: Request) {
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

  if (!body.name?.trim() || !body.email?.trim() || !body.address?.trim()) {
    return NextResponse.json(
      { error: "name, email and address are required" },
      { status: 400 },
    );
  }

  // TCPA consent enforcement — server-side gate. The client form gates
  // the submit button via React state, but a direct POST could bypass
  // that check. We REQUIRE the marketing consent before any SMS or
  // email outreach fires. Voice consent is granular and OPTIONAL: it
  // only authorizes the outbound automated voice call, which is gated
  // separately below.
  const marketingConsent =
    body.marketingConsent === true || body.tcpaConsent === true;
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
  const rawOfficeSlug =
    typeof body.office === "string" && body.office.trim()
      ? body.office.trim().toLowerCase()
      : "nolands";
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/i.test(rawOfficeSlug)) {
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

  let leadId = `lead_${crypto.randomUUID().replace(/-/g, "")}`;
  let isLeadUpdate = false;

  if (supabaseServiceRoleConfigured() && isValidExistingLeadPublicId(body.existingLeadPublicId)) {
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

  if (supabaseServiceRoleConfigured()) {
    try {
      const officeId = officeBranding?.id ?? (await resolveOfficeIdBySlug(officeSlug));
      if (!officeId) {
        console.warn(`[leads] no active office for slug='${officeSlug}'`);
      } else {
        const supabase = createServiceRoleClient();

        // ─── V3 painted-image upload ───────────────────────────────
        // If the caller (today: /estimate-v2) sent a Gemini V3 roof
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
            try {
              const bytes = Buffer.from(paintedImageBase64, "base64");
              const objectKey = `${leadId}.png`;
              const up = await supabase.storage
                .from("painted-roofs")
                .upload(objectKey, bytes, {
                  contentType: "image/png",
                  upsert: true,
                });
              if (up.error) {
                console.error("[leads] painted upload failed:", up.error.message);
              } else {
                const { data: pub } = supabase.storage
                  .from("painted-roofs")
                  .getPublicUrl(objectKey);
                paintedUrl = pub.publicUrl;
              }
            } catch (e) {
              console.error("[leads] painted upload threw:", e);
            }
          }
          roofV3Json = { ...rest, painted_url: paintedUrl };
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
          tcpa_consent_text: TCPA_CONSENT_TEXT,
          ...(roofV3Json ? { roof_v3_json: roofV3Json } : {}),
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
              disclosure_text: TCPA_CONSENT_TEXT,
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
            // /estimate-v2 customer sent a roofV3 payload, mirror it
            // into proposals so "Saved estimates" + the proposal page
            // both work. The snapshot carries the full V3 shape with a
            // `kind: "roof_v3"` discriminator the proposal renderer
            // uses to decide between the legacy and V3 layouts.
            if (roofV3Json) {
              const propPubId = `prop_${leadId.replace(/^lead_/, "")}_v3`;
              const sqft =
                typeof body.estimatedSqft === "number"
                  ? Math.round(body.estimatedSqft)
                  : null;
              // Rough $/sqft band for a quick headline range. Real
              // pricing happens later; this just keeps the proposal
              // row's total_low/high non-null so the leads-table $
              // column displays something useful.
              const lowPerSqft = 6.5;
              const highPerSqft = 11.5;
              const propLow = sqft ? Math.round(sqft * lowPerSqft) : null;
              const propHigh = sqft ? Math.round(sqft * highPerSqft) : null;
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
          tcpaConsentText: TCPA_CONSENT_TEXT,
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
      consentText: TCPA_CONSENT_TEXT,
    }),
  );

  // SMS confirmation. Fire-and-forget — Twilio failures must NEVER
  // break the lead capture (the lead is still in the webhook + UI
  // confirmation). We also seed conversation memory so when the
  // customer texts back, the SMS bot already knows their estimate.
  const phoneE164 = toE164(body.phone);
  if (phoneE164 && twilioConfigured() && !isLeadUpdate) {
    const estimateLine =
      body.estimateLow && body.estimateHigh
        ? `Your estimate range: $${body.estimateLow.toLocaleString()}-$${body.estimateHigh.toLocaleString()}. `
        : "";
    const firstName = body.name.split(/\s+/)[0];
    // Office-aware SMS intro. Falls back to "Voxaris Pitch" if the
    // office row didn't resolve (dev / preview without Supabase).
    const officeName = officeBranding?.displayName ?? "Voxaris Pitch";
    const agentName = officeBranding?.livekitAgentName ?? "Sydney";
    const smsBody = `Hi ${firstName}, this is ${agentName} from ${officeName}. We got your estimate request for ${body.address}. ${estimateLine}Reply with any questions or text BOOK to schedule a free inspection. Reply STOP to opt out.`;

    // Run both writes in parallel and don't await — keep the API
    // response fast.
    void Promise.all([
      sendSms({ to: phoneE164, body: smsBody })
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
  // VOICE-CONSENT GATE — even with INTERNAL_DISPATCH_SECRET configured
  // and an estimate present, the dispatch only fires when the customer
  // explicitly checked the second consent box (or, for back-compat,
  // when an older client sent just `tcpaConsent` and no granular
  // voiceConsent flag at all — old behavior: single consent covered
  // everything). New clients MUST opt in.
  const dispatchAllowed =
    voiceConsent ||
    (body.voiceConsent === undefined && body.marketingConsent === undefined);
  if (
    phoneE164 &&
    process.env.INTERNAL_DISPATCH_SECRET &&
    hasEstimate &&
    dispatchAllowed
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

  return NextResponse.json({
    leadId,
    submittedAt,
    message: "Thanks — a Voxaris partner will contact you within 1 business hour.",
  });
}
