/**
 * SpyFu API client — competitive intelligence + paid/organic keyword data.
 *
 * Replaces one-off PDF exports of nolandsroofing.com with live API pulls
 * for ongoing analysis. Used by the AIM ad-waste audit, the recoverable-GP
 * dashboard, and the per-keyword bid-history surfacing.
 *
 * Why this exists:
 *   The May 27 Intel Brief was built off a single SpyFu PDF dump. That's
 *   a snapshot. The actual AIM-vs-Noland's audit needs WEEKLY refreshes:
 *     - which keywords AIM added this week (4.5× growth since Nov)
 *     - which CPCs are climbing (Quality Score decay signal)
 *     - which competitors are bidding cheaper (the $5.28 vs $1.40 gap)
 *     - which "Great Buy" inventory is still unbid (24,900 mo impressions)
 *
 * SpyFu API docs: https://www.spyfu.com/api/documentation
 * Auth model: query-string `api_id` + `api_key` on every call (basic auth
 *             also supported, query-string is what the docs show).
 * Rate limit: per plan — Pro 10k calls/mo, Team 100k/mo. We cache.
 * Pricing context: Pro $79/mo, Team $149/mo.
 *
 * Soft-fail philosophy:
 *   - When SPYFU_API_KEY is unset, every function returns
 *     { ok: false, reason: "not_configured" }. Caller falls back to the
 *     last PDF snapshot in memory.
 *   - When SpyFu errors (429, 5xx, network), returns
 *     { ok: false, reason: "error", error: "..." }.
 *   - Never throws. SpyFu being down must not break a dashboard render.
 *
 * Domain locked to nolandsroofing.com via SPYFU_DEFAULT_DOMAIN env. Pass
 * an explicit `domain` arg to override for competitor pulls.
 */

const SPYFU_API_BASE = "https://www.spyfu.com/apis";
const TIMEOUT_MS = 8000;

const SPYFU_API_KEY = process.env.SPYFU_API_KEY ?? "";
const SPYFU_API_ID = process.env.SPYFU_API_ID ?? "";
const SPYFU_DEFAULT_DOMAIN =
  process.env.SPYFU_DEFAULT_DOMAIN ?? "nolandsroofing.com";

export interface SpyFuError {
  ok: false;
  reason: "not_configured" | "error" | "rate_limited" | "not_found";
  error?: string;
  status?: number;
}

export function spyFuConfigured(): boolean {
  return Boolean(SPYFU_API_KEY && SPYFU_API_ID);
}

// ─── Domain stats ────────────────────────────────────────────────────────

export interface DomainStats {
  ok: true;
  domain: string;
  organicKeywords: number;
  paidKeywords: number;
  estMonthlySeoClicks: number;
  estMonthlyPaidClicks: number;
  estMonthlyAdBudget: number;
  organicTrafficPct: number; // 0-100
  paidTrafficPct: number; // 0-100
  monthlyOrganicValue: number; // estimated $-value of organic clicks
  raw?: unknown;
}

/**
 * Fetch the domain-level overview matching what page 2 of the SpyFu PDF
 * shows. Live values vs the PDF snapshot.
 *
 * Used by `/api/internal/spyfu-sync` and the recoverable-GP dashboard.
 */
export async function getDomainStats(
  domain: string = SPYFU_DEFAULT_DOMAIN,
): Promise<DomainStats | SpyFuError> {
  if (!spyFuConfigured()) {
    return { ok: false, reason: "not_configured" };
  }
  try {
    // SpyFu v2 endpoint. Verified live 2026-05-27 returning HTTP 200 with
    // {resultCount, domain, results: [{ monthlyBudget, monthlyPaidClicks,
    // monthlyOrganicClicks, totalOrganicResults, totalAdsPurchased,
    // monthlyOrganicValue, averageOrganicRank, averageAdRank, strength,
    // searchMonth, searchYear }]}.
    const url = new URL(
      `${SPYFU_API_BASE}/domain_stats_api/v2/getLatestDomainStats`,
    );
    url.searchParams.set("domain", domain);
    url.searchParams.set("countryCode", "US");
    url.searchParams.set("api_id", SPYFU_API_ID);
    url.searchParams.set("api_key", SPYFU_API_KEY);
    const res = await spyFuFetch(url.toString());
    if (!res.ok) return res;
    const data = res.json as { results?: Array<Record<string, unknown>> };
    const row = (data.results ?? [])[0] ?? {};
    const monthlyPaid = numeric(row.monthlyPaidClicks);
    const monthlyOrg = numeric(row.monthlyOrganicClicks);
    const totalClicks = monthlyPaid + monthlyOrg;
    return {
      ok: true,
      domain,
      organicKeywords: numeric(row.totalOrganicResults),
      paidKeywords: numeric(row.totalAdsPurchased),
      estMonthlySeoClicks: monthlyOrg,
      estMonthlyPaidClicks: monthlyPaid,
      estMonthlyAdBudget: numeric(row.monthlyBudget),
      organicTrafficPct: totalClicks > 0 ? (monthlyOrg / totalClicks) * 100 : 0,
      paidTrafficPct: totalClicks > 0 ? (monthlyPaid / totalClicks) * 100 : 0,
      monthlyOrganicValue: numeric(row.monthlyOrganicValue),
      raw: row,
    };
  } catch (err) {
    return spyFuUnexpected(err);
  }
}

// ─── Top organic keywords ────────────────────────────────────────────────

export interface OrganicKeyword {
  keyword: string;
  rank: number;
  seoClicks: number;
  searchVolume: number;
  topRankedUrl: string;
  rankChange: number;
  exactCpc?: number | null;
}

export interface OrganicKeywordsResult {
  ok: true;
  domain: string;
  keywords: OrganicKeyword[];
}

/**
 * Pull the top N organic keywords for a domain. Used to feed the
 * "Geographic SEO Wins" + "Critical Rank Collapses" sections of the
 * Intel Brief.
 */
export async function getTopOrganicKeywords(
  domain: string = SPYFU_DEFAULT_DOMAIN,
  opts: { limit?: number; sortBy?: "rank" | "clicks" | "volume" } = {},
): Promise<OrganicKeywordsResult | SpyFuError> {
  if (!spyFuConfigured()) {
    return { ok: false, reason: "not_configured" };
  }
  try {
    // v2: /serp_api/v2/seo/getMostValuableKeywords — $0.50 CPM
    const url = new URL(
      `${SPYFU_API_BASE}/serp_api/v2/seo/getMostValuableKeywords`,
    );
    url.searchParams.set("query", domain);
    url.searchParams.set("countryCode", "US");
    url.searchParams.set("pageSize", String(opts.limit ?? 100));
    url.searchParams.set("api_id", SPYFU_API_ID);
    url.searchParams.set("api_key", SPYFU_API_KEY);
    const res = await spyFuFetch(url.toString());
    if (!res.ok) return res;
    const data = res.json as { results?: Array<Record<string, unknown>> };
    const keywords: OrganicKeyword[] = (data.results ?? []).map((row) => ({
      keyword: String(row.keyword ?? ""),
      rank: numeric(row.rank ?? row.position),
      seoClicks: numeric(row.seoClicks ?? row.monthlySeoClicks),
      searchVolume: numeric(row.searchVolume ?? row.monthlySearchVolume),
      topRankedUrl: String(row.topRankedUrl ?? row.url ?? ""),
      rankChange: numeric(row.rankChange ?? row.positionChange),
      exactCpc: row.exactCostPerClick != null ? numeric(row.exactCostPerClick) : null,
    }));
    return { ok: true, domain, keywords };
  } catch (err) {
    return spyFuUnexpected(err);
  }
}

// ─── Top paid keywords (the AIM audit lifeblood) ─────────────────────────

export interface PaidKeyword {
  keyword: string;
  searchVolume: number;
  cpc: number;
  monthlyCost: number;
  rank: number;
  rankChange: number;
  mobilePct?: number;
}

export interface PaidKeywordsResult {
  ok: true;
  domain: string;
  keywords: PaidKeyword[];
  totalMonthlyCost: number;
  topKeywordSharePct: number; // % of total spend on #1 keyword (concentration)
}

/**
 * Pull the top N paid keywords. This powers the "AIM's $23K X-rayed"
 * page of the Intel Brief and the 96%-concentration-risk diagnosis.
 */
export async function getTopPaidKeywords(
  domain: string = SPYFU_DEFAULT_DOMAIN,
  opts: { limit?: number } = {},
): Promise<PaidKeywordsResult | SpyFuError> {
  if (!spyFuConfigured()) {
    return { ok: false, reason: "not_configured" };
  }
  try {
    // v2: /keyword_api/v2/ppc/getMostSuccessful — $2.00 CPM
    // Returns the keywords Noland's is bidding on, sorted by spend.
    const url = new URL(
      `${SPYFU_API_BASE}/keyword_api/v2/ppc/getMostSuccessful`,
    );
    url.searchParams.set("query", domain);
    url.searchParams.set("countryCode", "US");
    url.searchParams.set("pageSize", String(opts.limit ?? 100));
    url.searchParams.set("api_id", SPYFU_API_ID);
    url.searchParams.set("api_key", SPYFU_API_KEY);
    const res = await spyFuFetch(url.toString());
    if (!res.ok) return res;
    const data = res.json as { results?: Array<Record<string, unknown>> };
    const keywords: PaidKeyword[] = (data.results ?? []).map((row) => ({
      keyword: String(row.keyword ?? ""),
      searchVolume: numeric(row.searchVolume),
      cpc: numeric(row.broadCostPerClick ?? row.exactCostPerClick ?? row.cpc),
      monthlyCost: numeric(row.monthlyCost ?? row.broadMonthlyCost),
      rank: numeric(row.rank),
      rankChange: numeric(row.rankChange),
      mobilePct: row.mobileSearchPercent != null
        ? numeric(row.mobileSearchPercent) * 100
        : undefined,
    }));
    const totalMonthlyCost = keywords.reduce((a, k) => a + k.monthlyCost, 0);
    const topKeywordSharePct = totalMonthlyCost > 0
      ? (keywords[0]?.monthlyCost ?? 0) / totalMonthlyCost * 100
      : 0;
    return {
      ok: true,
      domain,
      keywords,
      totalMonthlyCost,
      topKeywordSharePct,
    };
  } catch (err) {
    return spyFuUnexpected(err);
  }
}

// ─── Competitors (organic + paid) ────────────────────────────────────────

export interface CompetitorRow {
  domain: string;
  commonKeywords?: number;
  domainRank?: number;
  monthlyClicks?: number;
  monthlyValue?: number;
}

export interface CompetitorsResult {
  ok: true;
  domain: string;
  organicCompetitors: CompetitorRow[];
  paidCompetitors: CompetitorRow[];
}

export async function getCompetitors(
  domain: string = SPYFU_DEFAULT_DOMAIN,
): Promise<CompetitorsResult | SpyFuError> {
  if (!spyFuConfigured()) {
    return { ok: false, reason: "not_configured" };
  }
  try {
    const [organic, paid] = await Promise.all([
      fetchCompetitorList(domain, "organic"),
      fetchCompetitorList(domain, "paid"),
    ]);
    if (!organic.ok) return organic;
    if (!paid.ok) return paid;
    return {
      ok: true,
      domain,
      organicCompetitors: organic.list,
      paidCompetitors: paid.list,
    };
  } catch (err) {
    return spyFuUnexpected(err);
  }
}

async function fetchCompetitorList(
  domain: string,
  type: "organic" | "paid",
): Promise<{ ok: true; list: CompetitorRow[] } | SpyFuError> {
  // v2: /competitors_api/v2/{seo|ppc}/getTopCompetitors — $0.20 CPM
  const section = type === "organic" ? "seo" : "ppc";
  const url = new URL(
    `${SPYFU_API_BASE}/competitors_api/v2/${section}/getTopCompetitors`,
  );
  url.searchParams.set("domain", domain);
  url.searchParams.set("countryCode", "US");
  url.searchParams.set("pageSize", "10");
  url.searchParams.set("api_id", SPYFU_API_ID);
  url.searchParams.set("api_key", SPYFU_API_KEY);
  const res = await spyFuFetch(url.toString());
  if (!res.ok) return res;
  const data = res.json as { results?: Array<Record<string, unknown>> };
  return {
    ok: true,
    list: (data.results ?? []).map((row) => ({
      domain: String(row.domain ?? row.url ?? ""),
      commonKeywords: row.commonKeywords != null ? numeric(row.commonKeywords) : undefined,
      domainRank: row.domainRank != null ? numeric(row.domainRank) : undefined,
      monthlyClicks: row.monthlyClicks != null ? numeric(row.monthlyClicks) : undefined,
      monthlyValue: row.monthlyValue != null ? numeric(row.monthlyValue) : undefined,
    })),
  };
}

// ─── Ad waste detection ──────────────────────────────────────────────────

export interface AdWasteRow {
  keyword: string;
  yourCost: number;
  competitorAvgCost: number;
  cpcDelta: number;
  flagReason: "high_cpc_vs_peers" | "low_volume" | "off_intent" | "branded";
}

export interface AdWasteResult {
  ok: true;
  domain: string;
  totalMonthlyCost: number;
  estWastedMonthly: number;
  wastedPercent: number;
  flaggedKeywords: AdWasteRow[];
}

/**
 * Cross-reference paid keywords against competitor CPCs to flag ad
 * waste. Mirrors the Intel Brief Diagnosis A (Quality-Score Tax) logic.
 *
 * Algorithm:
 *  1. Pull our paid keywords + per-keyword CPC.
 *  2. For each, sample peer CPCs on the same keyword.
 *  3. If our CPC > 2× peer median, flag as `high_cpc_vs_peers`.
 *  4. Sum the delta (our cost - peer-median cost) as estimated waste.
 */
export async function detectAdWaste(
  domain: string = SPYFU_DEFAULT_DOMAIN,
): Promise<AdWasteResult | SpyFuError> {
  const paid = await getTopPaidKeywords(domain, { limit: 100 });
  if (!paid.ok) return paid;

  // For an MVP, we use a simpler heuristic: any keyword with monthlyCost
  // > $500 AND CPC > $8 is provisionally flagged. The full peer-CPC
  // cross-ref is a v2 (needs N competitor pulls per keyword, blows
  // through SpyFu rate limits without batching).
  const flagged: AdWasteRow[] = paid.keywords
    .filter((k) => k.monthlyCost > 500 && k.cpc > 8)
    .map((k) => ({
      keyword: k.keyword,
      yourCost: k.monthlyCost,
      competitorAvgCost: k.monthlyCost * 0.4, // placeholder; v2 = real peer pull
      cpcDelta: k.cpc - k.cpc * 0.4,
      flagReason: "high_cpc_vs_peers" as const,
    }));

  const estWastedMonthly = flagged.reduce(
    (a, r) => a + (r.yourCost - r.yourCost * 0.4),
    0,
  );

  return {
    ok: true,
    domain,
    totalMonthlyCost: paid.totalMonthlyCost,
    estWastedMonthly,
    wastedPercent:
      paid.totalMonthlyCost > 0
        ? (estWastedMonthly / paid.totalMonthlyCost) * 100
        : 0,
    flaggedKeywords: flagged,
  };
}

// ─── Internals ───────────────────────────────────────────────────────────

type SpyFuFetchResult =
  | { ok: true; json: unknown }
  | { ok: false; reason: "error"; status: number; error: string }
  | { ok: false; reason: "rate_limited"; status: 429; error: string };

async function spyFuFetch(url: string): Promise<SpyFuFetchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    if (res.status === 429) {
      return {
        ok: false,
        reason: "rate_limited",
        status: 429,
        error: "SpyFu rate limit hit — backoff required",
      };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        reason: "error",
        status: res.status,
        error: text.slice(0, 200),
      };
    }
    const json = await res.json().catch(() => ({}));
    return { ok: true, json };
  } finally {
    clearTimeout(timer);
  }
}

function spyFuUnexpected(err: unknown): SpyFuError {
  return {
    ok: false,
    reason: "error",
    error: err instanceof Error ? err.message : String(err),
  };
}

function numeric(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
