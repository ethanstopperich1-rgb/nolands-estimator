/**
 * GET /api/cron/competitor-scrape
 *
 * Nightly scrape of EagleView's + Roofr's public marketing pages —
 * pricing tiers, product feature claims, leadership shifts, press
 * releases. Result is a JSON blob written to Vercel Blob under
 * `competitors/{YYYY-MM-DD}/{slug}.json` plus a diff summary against
 * the prior day so we know the moment they reprice or rename a
 * product.
 *
 * Wired in vercel.json crons: nightly at 04:00 UTC (midnight ET).
 *
 * Auth: gated by CRON_SECRET (Vercel injects + signs each invocation
 * with `x-vercel-cron-signature`; we accept either as a backstop).
 *
 * Runtime: Node — needs the Buffer API, not edge.
 * maxDuration: 120s — each target is one fetch + parse pass, 12 targets
 *   typically completes in 30–60s but we leave headroom for slow upstreams.
 *
 * Stealth: this route uses plain `fetch` with a normal browser UA, NOT
 * CloakBrowser, because Vercel serverless functions don't host a
 * Chromium binary (250 MB unzipped cap). For pages that DO trip
 * bot-detection (rare on marketing surfaces — those want indexing),
 * we fall through and log the block so we can investigate. The bulk
 * of EagleView's + Roofr's marketing is HubSpot / Webflow / static
 * and behaves like normal HTML.
 */

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { put, list } from "@vercel/blob";

export const runtime = "nodejs";
export const maxDuration = 120;

interface Target {
  slug: string;
  url: string;
  /** Regex that captures the meaningful content slice — usually a price
   *  range or feature claim. Multiple regexes get OR'd. */
  extractors?: RegExp[];
}

// Order matters only for log readability. URLs verified live 2026-05.
const TARGETS: Target[] = [
  // ── EagleView ──────────────────────────────────────────────────────
  { slug: "ev-home", url: "https://www.eagleview.com/" },
  { slug: "ev-pricing", url: "https://www.eagleview.com/pricing/" },
  { slug: "ev-residential", url: "https://www.eagleview.com/industries/residential/" },
  { slug: "ev-press", url: "https://www.eagleview.com/press-releases/" },
  { slug: "ev-leadership", url: "https://www.eagleview.com/leadership/" },
  { slug: "ev-news", url: "https://www.eagleview.com/news/" },
  // ── Roofr ──────────────────────────────────────────────────────────
  { slug: "roofr-home", url: "https://www.roofr.com/" },
  { slug: "roofr-pricing", url: "https://www.roofr.com/pricing" },
  { slug: "roofr-about", url: "https://www.roofr.com/about" },
  { slug: "roofr-blog", url: "https://www.roofr.com/blog" },
  { slug: "roofr-reviews", url: "https://www.roofr.com/reviews" },
];

/** Strip scripts / styles / common chrome so the diff signal is the
 *  CONTENT, not a hash-key on a script tag. Returns lowercased,
 *  whitespace-normalized text. */
function cleanHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pull dollar prices + "X per Y" patterns out of the cleaned text so
 *  the structured diff highlights pricing changes specifically. */
function extractPricing(text: string): string[] {
  const out = new Set<string>();
  // $99/month, $13 per report, etc.
  const re = /\$\d[\d,]*(?:\.\d{1,2})?\s*(?:\/\s*\w+|per\s+\w+|mo|month|year|user|report|seat|sq\s*ft|square)?/gi;
  const m = text.match(re);
  if (m) for (const s of m) out.add(s.trim().replace(/\s+/g, " "));
  return Array.from(out).sort();
}

async function fetchOne(t: Target): Promise<{
  slug: string;
  url: string;
  fetchedAt: string;
  ok: boolean;
  status: number;
  contentHash: string;
  pricingTokens: string[];
  textLength: number;
  textPreview: string;
  error?: string;
}> {
  const fetchedAt = new Date().toISOString();
  try {
    const res = await fetch(t.url, {
      headers: {
        // Normal-looking desktop Chrome UA. EagleView + Roofr both
        // index well via search engines so they don't gate based on UA.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      return {
        slug: t.slug,
        url: t.url,
        fetchedAt,
        ok: false,
        status: res.status,
        contentHash: "",
        pricingTokens: [],
        textLength: 0,
        textPreview: "",
        error: `http_${res.status}`,
      };
    }
    const html = await res.text();
    const text = cleanHtml(html);
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    return {
      slug: t.slug,
      url: t.url,
      fetchedAt,
      ok: true,
      status: res.status,
      contentHash: hash,
      pricingTokens: extractPricing(text),
      textLength: text.length,
      textPreview: text.slice(0, 4000),
    };
  } catch (err) {
    return {
      slug: t.slug,
      url: t.url,
      fetchedAt,
      ok: false,
      status: 0,
      contentHash: "",
      pricingTokens: [],
      textLength: 0,
      textPreview: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Most recent snapshot for a slug from yesterday (or whatever's
 *  still in Blob storage). Returns null when there's no prior data
 *  (first run, blob expired, etc.). */
async function loadPrior(slug: string): Promise<{
  contentHash: string;
  pricingTokens: string[];
} | null> {
  try {
    // List the last 50 blobs for this slug, take the newest that
    // isn't from today (we don't want to diff against the run we're
    // about to write).
    const today = new Date().toISOString().slice(0, 10);
    const { blobs } = await list({ prefix: `competitors/`, limit: 1000 });
    const matching = blobs
      .filter((b) => b.pathname.endsWith(`/${slug}.json`))
      .filter((b) => !b.pathname.startsWith(`competitors/${today}/`))
      .sort((a, b) => b.pathname.localeCompare(a.pathname));
    const newest = matching[0];
    if (!newest) return null;
    const res = await fetch(newest.url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const prior = (await res.json()) as {
      contentHash?: string;
      pricingTokens?: string[];
    };
    return {
      contentHash: prior.contentHash ?? "",
      pricingTokens: prior.pricingTokens ?? [],
    };
  } catch {
    return null;
  }
}

interface DiffSummary {
  slug: string;
  url: string;
  changed: boolean;
  pricingChanged: boolean;
  addedPricing: string[];
  removedPricing: string[];
  prevHash: string | null;
  currHash: string;
}

function diff(
  curr: { slug: string; url: string; contentHash: string; pricingTokens: string[] },
  prior: { contentHash: string; pricingTokens: string[] } | null,
): DiffSummary {
  if (!prior) {
    return {
      slug: curr.slug,
      url: curr.url,
      changed: false,
      pricingChanged: false,
      addedPricing: [],
      removedPricing: [],
      prevHash: null,
      currHash: curr.contentHash,
    };
  }
  const prevSet = new Set(prior.pricingTokens);
  const currSet = new Set(curr.pricingTokens);
  return {
    slug: curr.slug,
    url: curr.url,
    changed: prior.contentHash !== curr.contentHash,
    pricingChanged:
      prior.pricingTokens.join("|") !== curr.pricingTokens.join("|"),
    addedPricing: curr.pricingTokens.filter((p) => !prevSet.has(p)),
    removedPricing: prior.pricingTokens.filter((p) => !currSet.has(p)),
    prevHash: prior.contentHash,
    currHash: curr.contentHash,
  };
}

function authorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET ?? "";
  // Vercel cron signs requests with CRON_SECRET — accept the header only
  // when its value matches. Presence-alone is NOT sufficient (any caller
  // can add an arbitrary header). Mirrors /api/cron/storm-pulse.
  const vercelSig = req.headers.get("x-vercel-cron-signature");
  if (expected && vercelSig && vercelSig === expected) return true;
  // Manual / out-of-band trigger — accept Bearer + CRON_SECRET.
  const auth = req.headers.get("authorization") ?? "";
  if (expected && auth === `Bearer ${expected}`) return true;
  return false;
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "blob_not_configured" },
      { status: 503 },
    );
  }

  const datePrefix = new Date().toISOString().slice(0, 10);
  const diffs: DiffSummary[] = [];
  const errors: Array<{ slug: string; error: string }> = [];

  for (const t of TARGETS) {
    const curr = await fetchOne(t);
    if (!curr.ok) {
      errors.push({ slug: t.slug, error: curr.error ?? "unknown" });
      // Still write the failure blob so we have a record.
    }
    const path = `competitors/${datePrefix}/${t.slug}.json`;
    try {
      await put(path, JSON.stringify(curr, null, 2), {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
      });
    } catch (err) {
      console.warn(
        `[competitor-scrape] blob write failed for ${t.slug}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    if (curr.ok) {
      const prior = await loadPrior(t.slug);
      diffs.push(diff(curr, prior));
    }
  }

  // Surface anything material so the cron's response (and Vercel
  // function logs) double as the "what changed last night" feed.
  const interesting = diffs.filter(
    (d) => d.changed || d.pricingChanged,
  );

  return NextResponse.json({
    ok: true,
    fetchedAt: new Date().toISOString(),
    targets: TARGETS.length,
    succeeded: TARGETS.length - errors.length,
    errors,
    changes: interesting,
    summary: diffs.map((d) => ({
      slug: d.slug,
      changed: d.changed,
      pricingChanged: d.pricingChanged,
    })),
  });
}
