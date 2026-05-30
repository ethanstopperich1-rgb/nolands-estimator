/**
 * lib/sms-cold-start.ts — the "Text ROOF to (888) 786-9134" cold-start
 * booking flow (Gap 3).
 *
 * A brand-new texter (no lead on file) who texts the advertised keyword
 * enters a tolerant capture→book funnel:
 *   ROOF → greet + ask address → ask first name → create lead → offer
 *   two AVAILABLE slots (selectAvailableSlots) → A/B pick books in JN.
 *
 * Design:
 *   - The booking spine is DETERMINISTIC (the state machine + the
 *     existing slot-pick handler own slot offering + the JN write) so
 *     the LLM can never hallucinate a time or double-book.
 *   - Triggers ONLY on the advertised keyword(s). Organic cold texts
 *     ("hail last week, granules in my gutter") still fall through to
 *     the conversational LLM path, which itself steers toward ROOF /
 *     the estimator.
 *   - Voice: Noland's front-office — warm, direct, like a person, not a
 *     bot. No emojis, no markdown. Short (1 SMS segment where possible).
 *     Every path offers the estimator as the fast lane (all roads lead
 *     there) and the first message carries business ID + STOP (TCPA).
 *
 * NOTE (brand voice): copy here is modeled on Noland's existing reminder
 * templates + slot copy. To refine it from the reps' ACTUAL Podium
 * texting voice, re-auth Podium (token expired since send was retired),
 * then mine the transcript sample — this module is the single swap point.
 */

/** Toll-free SMS line, display form. The advertised "Text ROOF to ___". */
export const NOLANDS_SMS_NUMBER_DISPLAY = "(888) 786-9134";
/** Instant-estimator URL — the lead magnet every path points back to. */
export const ESTIMATOR_URL = "estimate.nolandsroofing.com";

/**
 * Does this inbound kick off the cold booking flow? The advertised
 * keyword is ROOF; we also accept the obvious intent synonyms a real
 * homeowner might text instead. Anchored at the start so "my roof leaks"
 * doesn't trigger the rigid funnel (that's a conversation for the LLM).
 */
export function isColdStartKeyword(body: string): boolean {
  return /^\s*(roof|inspection|estimate|quote|book)\b/i.test(body);
}

/**
 * Heuristic: does this reply look like a street address? We want a digit
 * (house/unit number) plus either a comma, a street suffix, or enough
 * words to be a real address — so "yes" / "ok" / a bare name don't get
 * mistaken for one.
 */
export function looksLikeAddress(body: string): boolean {
  const t = body.trim();
  if (!/\d/.test(t)) return false; // needs a number
  const hasSuffix =
    /\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|cir|circle|way|pl|place|ter|terrace|hwy|highway|trl|trail|pkwy|parkway|loop|run|cove|cv)\b/i.test(
      t,
    );
  const hasComma = t.includes(",");
  const wordCount = t.split(/\s+/).length;
  // ZIP-bearing or comma'd or suffixed or simply long enough to be real.
  return hasSuffix || hasComma || /\b\d{5}\b/.test(t) || wordCount >= 3;
}

/**
 * Pull a usable first name from a reply. Strips lead-ins ("my name is",
 * "i'm", "this is", "it's") and grabs the first token, title-cased.
 * Falls back to "" when nothing name-like is present.
 */
export function cleanFirstName(body: string): string {
  // Lead-ins ordered LONGEST-first so "my name is" wins over "my name's"
  // (ordered alternation — a shorter prefix would strip too little and
  // leave "is <name>"). Trailing separator class eats the comma/space.
  const t = body
    .trim()
    .replace(
      /^(?:my name is|my name'?s|i am|i'?m|this is|it'?s|the name'?s|name'?s|hi|hey|hello)[,'\s]+/i,
      "",
    )
    .trim();
  // First whitespace-delimited token, letters/hyphen/apostrophe only.
  const token = (t.split(/\s+/)[0] ?? "").replace(/[^A-Za-z'\-]/g, "");
  if (!token) return "";
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

/**
 * Junk first-name guard. Lead.name is sometimes a placeholder ("Mobile",
 * "Unknown", a synthetic value) — greeting "Got it, Mobile!" reads badly.
 * Returns a clean title-cased first name, or "there" when the value isn't
 * a plausible human name.
 */
const JUNK_NAMES = new Set([
  "mobile",
  "unknown",
  "sms",
  "lead",
  "customer",
  "there",
  "null",
  "undefined",
  "test",
  "noemail",
]);
export function safeFirstName(name: string | null | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  const cleaned = first.replace(/[^A-Za-z'\-]/g, "");
  if (!cleaned || JUNK_NAMES.has(cleaned.toLowerCase())) return "there";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

/** First reply after ROOF — greet, ask for the address, offer the
 *  estimator fast lane, and carry business ID + STOP (TCPA first msg). */
export function coldGreetingBody(): string {
  return (
    `Hey, it's Noland's Roofing! Happy to set you up with a free roof inspection — ` +
    `what's the property address? ` +
    `(Want a price first? Free instant estimate at ${ESTIMATOR_URL}) ` +
    `Reply STOP to opt out.`
  ).slice(0, 320);
}

/** Re-ask when the address reply didn't look like an address. */
export function coldRetryAddressBody(): string {
  return (
    `Want to make sure the right crew heads out — what's the street address + city? ` +
    `Or grab an instant estimate now at ${ESTIMATOR_URL}.`
  ).slice(0, 320);
}

/** Ask for the homeowner's first name once we have the address. */
export function coldAskNameBody(): string {
  return `Perfect. Who should we put the inspection under — first name's fine?`;
}
