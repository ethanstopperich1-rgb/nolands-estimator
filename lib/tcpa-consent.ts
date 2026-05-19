/**
 * TCPA disclosure text — server is authoritative; UI must show the same
 * wording the server stores on consent rows.
 */

/** Platform vendor named in disclosures when no office row exists. */
export const TCPA_PLATFORM_VENDOR = "Voxaris";

/**
 * Marketing consent (email + SMS). `{{office_name}}` is the one named
 * seller per FCC one-to-one consent (effective Jan 2025).
 */
export const MARKETING_CONSENT_TEMPLATE =
  "By submitting this form, you consent to receive automated marketing " +
  "calls, texts, and emails from {{office_name}} at the phone number and " +
  "email provided. Consent is not required to make a purchase. Message " +
  "frequency varies; message and data rates may apply. Reply STOP to opt " +
  "out, HELP for help. See our Privacy Policy at /privacy and Terms of " +
  "Service at /terms.";

/** Voice intro after estimate — mirrors voice-consent route template. */
export const VOICE_CONSENT_DISCLOSURE_TEMPLATE =
  "Customer authorized an automated outbound voice intro call from " +
  "{{office_name}} after viewing their estimate. Recording may apply " +
  "where permitted by law. Reply STOP to opt out.";

export function buildMarketingConsentText(officeDisplayName: string): string {
  const name = officeDisplayName.trim() || TCPA_PLATFORM_VENDOR;
  return MARKETING_CONSENT_TEMPLATE.replace(/\{\{office_name\}\}/g, name);
}

export function buildVoiceConsentDisclosureText(officeDisplayName: string): string {
  const name = officeDisplayName.trim() || "the assigned business";
  return VOICE_CONSENT_DISCLOSURE_TEMPLATE.replace(/\{\{office_name\}\}/g, name);
}

/** @deprecated Use buildMarketingConsentText — kept for imports during migration */
export const TCPA_CONSENT_TEXT = buildMarketingConsentText(TCPA_PLATFORM_VENDOR);
