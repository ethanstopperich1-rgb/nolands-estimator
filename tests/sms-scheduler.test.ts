/**
 * Unit tests for lib/sms-scheduler.ts — focused on the Gap-1
 * availability logic (selectAvailableSlots). Deterministic: tests are
 * self-consistent — they feed the module's OWN slot ISO output back in
 * as "booked" times, so there's no hardcoded timezone/weekday math to
 * drift. Run: npx tsx --test tests/sms-scheduler.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectAvailableSlots, nextBusinessSlots } from "../lib/sms-scheduler";

function isoToUnix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

// Fixed anchor so runs are reproducible. The tests never assume which
// weekday this is — they compare baseline-vs-after behavior.
const FROM = new Date("2026-05-27T16:00:00Z");

test("no bookings → two fresh slots keyed A,B, identical to the blind generator", () => {
  const slots = selectAvailableSlots({ bookedUnix: [], from: FROM, count: 2 });
  assert.equal(slots.length, 2);
  assert.equal(slots[0].key, "A");
  assert.equal(slots[1].key, "B");
  const blind = nextBusinessSlots({ from: FROM, count: 2 });
  assert.equal(slots[0].iso, blind[0].iso);
  assert.equal(slots[1].iso, blind[1].iso);
});

test("a booked window is excluded and the offer rolls forward", () => {
  const baseline = selectAvailableSlots({ bookedUnix: [], from: FROM, count: 2 });
  const bookedUnix = [isoToUnix(baseline[0].iso)]; // book the first window
  const after = selectAvailableSlots({ bookedUnix, from: FROM, count: 2 });
  assert.equal(after.length, 2);
  const isos = after.map((s) => s.iso);
  assert.ok(!isos.includes(baseline[0].iso), "booked window should be excluded");
  assert.equal(after[0].key, "A");
  assert.equal(after[1].key, "B");
});

test("an evening booking does NOT block that day's morning/afternoon", () => {
  const baseline = selectAvailableSlots({ bookedUnix: [], from: FROM, count: 2 });
  // baseline[0] is a 9 AM ET window; +11h = 8 PM ET same day (out of window).
  const eveningUnix = isoToUnix(baseline[0].iso) + 11 * 3600;
  const after = selectAvailableSlots({
    bookedUnix: [eveningUnix],
    from: FROM,
    count: 2,
  });
  assert.equal(
    after[0].iso,
    baseline[0].iso,
    "an 8 PM booking must not consume the 9 AM window",
  );
});

test("both windows of a day booked → rolls to the next business day", () => {
  const baseline = selectAvailableSlots({
    bookedUnix: [],
    from: FROM,
    count: 4,
    maxBusinessDays: 5,
  });
  // baseline = [day1 AM, day1 PM, day2 AM, day2 PM]
  const bookedUnix = [isoToUnix(baseline[0].iso), isoToUnix(baseline[1].iso)];
  const after = selectAvailableSlots({ bookedUnix, from: FROM, count: 2 });
  const isos = after.map((s) => s.iso);
  assert.ok(!isos.includes(baseline[0].iso));
  assert.ok(!isos.includes(baseline[1].iso));
  assert.equal(after[0].iso, baseline[2].iso, "should roll to next business day AM");
});
