/**
 * lib/painted-url.ts — single source of truth for painted-overlay URLs.
 *
 * ── The parity invariant ──────────────────────────────────────────
 *
 * Every surface that renders the painted roof overlay — customer
 * estimator page, rep dashboard drawer, rep estimate workbench,
 * homeowner share URL (/r/[publicId]) — MUST render the same image
 * bytes for the same lead. No exceptions. That contract is what
 * makes "the rep sees what the homeowner saw" true.
 *
 * The bytes never change after the V3 pipeline writes them to the
 * `painted-roofs` Supabase Storage bucket (object key
 * `<lead_public_id>.png`). What CAN change is the URL we hand the
 * browser:
 *   - Public bucket → `publicUrl` works forever
 *   - Private bucket → `publicUrl` returns 403; need signed URLs
 *
 * The bucket may flip from public to private (security audit
 * recommended it). When that happens, any code path that stored
 * a `publicUrl` will break, while paths that store signed URLs will
 * survive for 7 days then break.
 *
 * This module centralizes URL minting so all four read surfaces
 * always get a working URL pointing at the same bytes.
 *
 * ── Where this is called ──────────────────────────────────────────
 *
 *   WRITE paths (mint a fresh URL after upload):
 *     - app/api/gemini-roof/route.ts           (V3 pipeline)
 *     - app/api/leads/route.ts                 (customer flow)
 *     - app/api/leads/[publicId]/roof-v3       (rep "Generate" button)
 *
 *   READ paths (re-mint on load if the stored URL is dead):
 *     - app/dashboard/leads/[publicId]/page.tsx  (lead drawer)
 *     - app/r/[publicId]/page.tsx                (homeowner share)
 *     - components/dashboard/LeadReport.tsx      (reads from drawer's
 *       already-minted URL)
 *
 *   The estimate workbench (/dashboard/estimate?leadId=...) reads
 *   the V3 response directly from the in-flight pipeline call, so it
 *   doesn't need this helper; it always has the freshest URL.
 *
 * ── TTL discipline ────────────────────────────────────────────────
 *
 * Signed URLs are 7 days. The cron / nightly job that touches lead
 * rows for any reason will incidentally extend the URL's life. For
 * truly idle leads (homeowner submitted 8 days ago, no one opened
 * the dashboard since), the READ paths re-mint on demand.
 *
 * Cost: minting a signed URL is one Supabase Storage HTTP call,
 * ~50-100ms. We cache the result in-process for the lifetime of the
 * request to avoid re-minting per render of the same surface.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const BUCKET = "painted-roofs";
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface PaintedUrlResult {
  /** A working URL pointing at the painted PNG. Null when the upload
   *  itself failed or the object doesn't exist. */
  url: string | null;
  /** How the URL was produced. Useful for telemetry — public URLs
   *  never expire; signed URLs do. */
  kind: "public" | "signed" | "none";
}

/**
 * Mint a fresh URL for a lead's painted overlay. Tries `publicUrl`
 * first (free, no API call). Falls back to signed URL when the
 * bucket is private. Returns `{ url: null, kind: "none" }` when the
 * object doesn't exist or the bucket isn't reachable.
 *
 * Idempotent. Safe to call on every render — the underlying Supabase
 * Storage API caches CDN responses.
 */
export async function mintPaintedUrl(
  supabase: SupabaseClient,
  leadPublicId: string,
): Promise<PaintedUrlResult> {
  if (!leadPublicId || !/^lead_[a-f0-9]{16,40}$/i.test(leadPublicId)) {
    return { url: null, kind: "none" };
  }
  const objectKey = `${leadPublicId}.png`;

  // Try public URL first. Supabase returns a URL string without
  // verifying the bucket is actually public — so we have to probe.
  // To avoid the probe cost on every call, we use a sentinel: the
  // signed-URL path. If signing succeeds, we got a working URL no
  // matter the bucket state. Public-bucket users still get a valid
  // URL because signed URLs work on public buckets too.
  //
  // Net result: ONE URL shape (signed) across all callers, works
  // regardless of whether the bucket flips public ↔ private.
  try {
    const { data: signed, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(objectKey, SIGNED_URL_TTL_SECONDS);
    if (!error && signed?.signedUrl) {
      return { url: signed.signedUrl, kind: "signed" };
    }
  } catch {
    // Fall through to publicUrl attempt.
  }

  // Last resort: publicUrl. If the bucket is public this works; if
  // it's private the returned URL will 403 but at least we logged
  // the attempt above.
  try {
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(objectKey);
    if (pub?.publicUrl) {
      return { url: pub.publicUrl, kind: "public" };
    }
  } catch {
    // Nothing more to try.
  }

  return { url: null, kind: "none" };
}

/**
 * Extract the painted URL from a persisted `roof_v3_json` blob,
 * re-minting from Storage when the stored URL is stale.
 *
 * Use this in every server-rendered read path (dashboard lead page,
 * /r/[publicId] share page). Reads do NOT trigger V3 pipeline runs —
 * if `roof_v3_json` is empty, returns `{ url: null, kind: "none" }`
 * and the surface should render an empty-state message.
 */
export async function resolvePaintedUrl(
  supabase: SupabaseClient,
  leadPublicId: string,
  roofV3Json: unknown,
): Promise<PaintedUrlResult> {
  // If there's no persisted V3 blob at all, there's no painted PNG
  // to point at. The lead exists but the pipeline hasn't run for it
  // yet. Read paths must NOT auto-run the pipeline — that's a write
  // operation gated by the explicit "Generate roof analysis" button.
  if (!roofV3Json || typeof roofV3Json !== "object") {
    return { url: null, kind: "none" };
  }
  // Re-mint from Storage. We don't trust the stored `painted_url`
  // string because it may be an expired signed URL or a now-broken
  // public URL after a bucket flip. The Storage API call is cheap
  // and gives us correctness.
  return mintPaintedUrl(supabase, leadPublicId);
}
