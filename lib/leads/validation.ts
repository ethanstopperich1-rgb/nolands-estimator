/** Shared lead validation — used by /api/leads and unit tests. */

const OFFICE_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/i;
const LEAD_PUBLIC_ID_RE = /^lead_[0-9a-f]{32}$/i;

/** Cap on the customer-supplied address text. Legitimate US street
 *  addresses are well under 200 chars; anything beyond is either
 *  storage/log bloat or an attempted prompt-injection payload. */
export const ADDRESS_MAX_LEN = 200;
/** Cap on the customer name field. */
export const NAME_MAX_LEN = 120;
/** Cap on the optional notes / freeform-text fields. */
export const FREEFORM_MAX_LEN = 2000;

export function isReasonableLength(
  value: unknown,
  max: number,
): value is string {
  return typeof value === "string" && value.length <= max;
}

export function isValidLeadPublicId(id: unknown): id is string {
  return typeof id === "string" && LEAD_PUBLIC_ID_RE.test(id.trim());
}

export function normalizeOfficeSlug(raw: unknown, defaultSlug = "nolands"): string {
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
