/**
 * Single source of truth for the homeowner-facing AI agent identity
 * and the office-line caller-ID, both of which appear in multiple
 * surfaces (RepCTACard, BookedSuccessCard, SMS templates, voice
 * consent label, share-page footer CTA).
 *
 * Why a module + not just a constant inline:
 *   - Renaming the agent in one place when Noland's decides "Sarah"
 *     → something else avoids hunting through 8 files.
 *   - Future white-label deployments (a non-Noland's contractor on
 *     this same codebase) can override the constants via env without
 *     touching code.
 *
 * Locked 2026-05 per the onboarding form Destiny returned:
 *   - Agent name: Sarah (formal tone, female voice)
 *   - Hot-transfer reps: Savannah, Myia, Amanda → (352) 242-4322
 *   - Main office line: (352) 242-4322
 *   - Sydney's outbound caller-ID (the LK SIP trunk number): +1 321 985 1104
 *
 * "Sydney" the codename remains the LiveKit agent worker name in
 * voxaris-pitch/agents/sydney/ — that's an INFRASTRUCTURE identifier,
 * not a customer-facing string. Don't conflate the two.
 */

/**
 * Customer-facing agent name. Shown in:
 *   - Voice consent label ("Yes, Sarah (our AI assistant) can call…")
 *   - SMS confirmation body
 *   - BookedSuccessCard countdown + reassurance copy
 *   - Reminder template fallback copy when no rep name is on the lead
 *
 * Override via env for non-Noland's deploys of this codebase:
 *   NEXT_PUBLIC_AGENT_DISPLAY_NAME=Jessica
 */
export const AGENT_DISPLAY_NAME =
  process.env.NEXT_PUBLIC_AGENT_DISPLAY_NAME?.trim() || "Sarah";

/**
 * Phone number the homeowner sees when Sarah calls them. This is the
 * LK SIP outbound trunk's caller-ID. Shown in the BookedSuccessCard
 * save-to-contacts callout. NOT the office line — that's MAIN_PHONE_E164.
 */
export const AGENT_CALLER_ID_E164 =
  process.env.NEXT_PUBLIC_AGENT_CALLER_ID?.trim() || "+13219851104";

/**
 * Human-readable formatting of AGENT_CALLER_ID_E164. Used in the
 * "Sarah calls from (321) 985-1104" copy.
 */
export const AGENT_CALLER_ID_FORMATTED =
  process.env.NEXT_PUBLIC_AGENT_CALLER_ID_FORMATTED?.trim() ||
  "(321) 985-1104";

/**
 * Noland's main published business line — where reps (Savannah, Myia,
 * Amanda) answer. Shown in the "Prefer to talk?" escape hatch on the
 * result page and used as the hot-transfer fallback destination from
 * Sarah's transfer_to_human tool.
 *
 * Was previously (352) 500-ROOF in AGENTS.md / RepCTACard; the May
 * 2026 onboarding form confirmed the actual line as 352-242-4322. The
 * 500-ROOF number is either retired or never went live — verify with
 * the office before publishing 500-ROOF anywhere else.
 */
export const MAIN_PHONE_E164 =
  process.env.NEXT_PUBLIC_MAIN_PHONE_E164?.trim() || "+13522424322";

export const MAIN_PHONE_FORMATTED =
  process.env.NEXT_PUBLIC_MAIN_PHONE_FORMATTED?.trim() ||
  "(352) 242-4322";

/**
 * Pricing-confirmation gate. When false (or unset), the result page
 * suppresses per-tier dollar values and shows a "Price confirmed at
 * walkthrough" pratfall line instead. This is a launch-safety lever:
 * the form Destiny returned left the per-sqft pricing fields BLANK,
 * so quoting customers off our FL-median assumption ($5.25-$9.50/sqft)
 * carries refund risk if Noland's real rates are materially different.
 *
 * Flip to true via:
 *   vercel env add NEXT_PUBLIC_PRICING_CONFIRMED production
 *   # value: "true"
 *
 * Once flipped, the tier cards render the full $/mo + total numbers
 * exactly like the upstream Voxaris pitch deploy.
 */
export const PRICING_CONFIRMED =
  process.env.NEXT_PUBLIC_PRICING_CONFIRMED === "true";
