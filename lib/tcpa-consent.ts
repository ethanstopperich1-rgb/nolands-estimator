/**
 * TCPA disclosure text — server is authoritative; UI must show the same
 * wording the server stores on consent rows.
 *
 * Compliance framework:
 *   - TCPA "prior express written consent" (47 CFR § 64.1200) for
 *     autodialed marketing calls/texts to wireless numbers.
 *   - FCC one-to-one consent rule (effective January 2025) requires
 *     consent be specific to a single named seller. We bind every
 *     consent row to the assigned office_id and substitute the office
 *     name into the disclosure template at consent time.
 *   - FCC 2024 declaratory ruling on AI-generated voice (8 February
 *     2024): AI-cloned and synthetic voice calls are "artificial" voice
 *     under the TCPA and require disclosure at consent. Our voice
 *     consent template now states "AI voice assistant" explicitly.
 *   - SHAKEN/STIR attestation required for outbound voice on toll-free
 *     numbers — handled at the Twilio Voice Trust layer, not here.
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

/**
 * Voice intro after estimate — mirrors voice-consent route template.
 *
 * "AI voice assistant" language is required, not optional. Per the
 * FCC's February 2024 declaratory ruling, AI-generated voice falls
 * under "artificial voice" in the TCPA and must be disclosed before
 * consent is captured. Without this language, the consent is invalid,
 * the call is illegal, and the toll-free number is at risk of being
 * flagged + de-verified by Twilio Voice Trust.
 *
 * Recording disclosure is bundled in the same template because this is
 * also the only consent moment the customer sees before the call lands.
 */
export const VOICE_CONSENT_DISCLOSURE_TEMPLATE =
  "Customer authorized an outbound voice intro call from {{office_name}} " +
  "placed by an AI voice assistant after viewing their estimate. " +
  "The call may be recorded where permitted by law. Reply STOP at any " +
  "time to opt out, or say \"remove me\" during the call to end future " +
  "contact.";

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
