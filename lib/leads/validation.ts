/** Shared lead validation — used by /api/leads and unit tests. */

const OFFICE_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/i;
const LEAD_PUBLIC_ID_RE = /^lead_[0-9a-f]{32}$/i;

export function isValidLeadPublicId(id: unknown): id is string {
  return typeof id === "string" && LEAD_PUBLIC_ID_RE.test(id.trim());
}

export function normalizeOfficeSlug(raw: unknown, defaultSlug = "voxaris"): string {
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim().toLowerCase();
  }
  return defaultSlug;
}

export function isValidOfficeSlug(slug: string): boolean {
  return OFFICE_SLUG_RE.test(slug);
}

export function hasMarketingConsent(body: {
  marketingConsent?: boolean;
  tcpaConsent?: boolean;
}): boolean {
  return body.marketingConsent === true || body.tcpaConsent === true;
}
