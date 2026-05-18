/**
 * Editorial roofing facts rotated through the V3 loading screen.
 *
 * Mix of insurance pain points, warranty / code gotchas, and value
 * framing — written in the Voxaris brand register: confident,
 * considered, low volume. Per the brand discipline: no buzzwords, no
 * countdowns, no exclamation marks. NOT a marketing screen —
 * informational. The customer reads ~5 of these during the ~22 s
 * measurement wait, which makes the bar feel like it's flying.
 *
 * Shared by:
 *   - `/`  (customer V3 estimator)
 *   - `/dashboard/estimate` (rep workbench)
 *
 * Both pages shuffle once at mount so repeat visitors don't see the
 * same 5 in the same order.
 *
 * Avoid claims we can't substantiate. Avoid the words "ACT NOW",
 * countdowns, or fake scarcity — those would clash with the brand
 * register and trigger the customer's BS detector.
 */
export const ROOFING_FACTS: readonly string[] = [
  "Florida insurance carriers commonly require roof replacement at 20–25 years to keep coverage active.",
  "Hail over 1.5 inches can void shingle warranties — even when damage isn't visible from the ground.",
  "A new roof typically returns 60–70% of its cost at resale, and homes with newer roofs sell faster.",
  "Architectural shingles last 25–30 years versus 15–20 for 3-tab — and qualify for stronger wind warranties.",
  "Wind-mitigation inspections often save $400–$1,200 a year on Florida homeowners insurance after a new roof.",
  "Cool-roof shingles can drop attic temperatures by 20–40 °F. Your AC runs less and lasts longer.",
  "Roof leaks caught at the attic stage cost about a third as much as ones caught at the ceiling.",
  "Algae streaks shorten shingle life by 5–10 years — and are typically excluded from manufacturer warranties.",
  "Florida's 2007 wind code requires hurricane straps. Older roofs almost always need them added at re-roof.",
  "Skylight leaks are usually the flashing, not the glass seal. Replacement requires both, not one.",
  "Drip edge installed correctly prevents up to 80% of fascia rot from wind-driven rain.",
  "Synthetic underlayment outperforms felt by roughly 4× in wind-uplift testing.",
  "Properly installed shingles withstand 110+ mph winds; uplift damage can start as low as 60 mph.",
  "Florida property insurance premiums rose more than 100% from 2018 to 2024. Roof age is the single biggest lever to bring them back down.",
  "After 15 years, most asphalt roofs have lost enough granules that UV protection is materially reduced.",
  "Most insurance claims for storm damage have a one-year filing window from the date of the event.",
] as const;
