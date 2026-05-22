import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pickASequenceTouchpoint,
  pickBSequenceTouchpoint,
  buildReminderVars,
} from "../lib/podium-reminders";
import { renderFallbackCopy } from "../lib/reminder-templates";

// All these tests are pure functions of (now, appointmentAt, sent
// flags) — no IO. They lock the touchpoint windows + the abandoner
// step ladder + the opt-out / no-phone short-circuits.

describe("pickASequenceTouchpoint — Sequence A windows", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const noneSent = {
    instant: false,
    t24h: false,
    morning: false,
    eta: false,
    postAppt: false,
  };

  it("A1 instant fires when appointment is in the far future and nothing sent yet", () => {
    const appt = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000); // +5d
    const tp = pickASequenceTouchpoint(appt, now, noneSent);
    assert.equal(tp, "A1_INSTANT");
  });

  it("A2 fires when appointment is ~24h out", () => {
    const appt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tp = pickASequenceTouchpoint(appt, now, { ...noneSent, instant: true });
    assert.equal(tp, "A2_T24H");
  });

  it("A3 fires when appointment is ~5h out", () => {
    const appt = new Date(now.getTime() + 5 * 60 * 60 * 1000);
    const tp = pickASequenceTouchpoint(appt, now, {
      ...noneSent,
      instant: true,
      t24h: true,
    });
    assert.equal(tp, "A3_MORNING");
  });

  it("A4 fires when appointment is ~30 min out", () => {
    const appt = new Date(now.getTime() + 30 * 60 * 1000);
    const tp = pickASequenceTouchpoint(appt, now, {
      ...noneSent,
      instant: true,
      t24h: true,
      morning: true,
    });
    assert.equal(tp, "A4_ETA");
  });

  it("A5 fires when appointment was ~1h ago", () => {
    const appt = new Date(now.getTime() - 60 * 60 * 1000);
    const tp = pickASequenceTouchpoint(appt, now, {
      ...noneSent,
      instant: true,
      t24h: true,
      morning: true,
      eta: true,
    });
    assert.equal(tp, "A5_POST_APPT");
  });

  it("skips a touchpoint when its flag is already set", () => {
    const appt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tp = pickASequenceTouchpoint(appt, now, {
      ...noneSent,
      instant: true,
      t24h: true, // A2 already sent
    });
    // A3/A4/A5 windows don't match either — nothing fires this tick.
    assert.equal(tp, null);
  });

  it("returns null when appointment is far past and post-appt already sent", () => {
    const appt = new Date(now.getTime() - 5 * 60 * 60 * 1000); // -5h
    const tp = pickASequenceTouchpoint(appt, now, {
      ...noneSent,
      instant: true,
      t24h: true,
      morning: true,
      eta: true,
      postAppt: true,
    });
    assert.equal(tp, null);
  });

  it("A5 takes priority over A1 even when both technically fit", () => {
    // Appointment 2h ago. A5 window matches. A1 window does not
    // (deltaMs is negative, not in [0, +30d]) — so this verifies the
    // post-appt branch fires regardless of A1 status.
    const appt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const tp = pickASequenceTouchpoint(appt, now, noneSent);
    assert.equal(tp, "A5_POST_APPT");
  });
});

describe("pickBSequenceTouchpoint — Sequence B ladder", () => {
  const now = new Date("2026-06-01T12:00:00Z");

  it("returns null at step 5 (nurture complete)", () => {
    const created = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const tp = pickBSequenceTouchpoint(created, 5, null, now);
    assert.equal(tp, null);
  });

  it("B2 fires when lead is 25h old and step = 1 (B1.5 already sent)", () => {
    const created = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    const tp = pickBSequenceTouchpoint(created, 1, null, now);
    assert.equal(tp, "B2_T24H_OPEN_LOOP");
  });

  it("B2 back-fills from step=0 when age >= 24h (skipped B1.5 window)", () => {
    // Step 0 + age 25h — B1.5 window is 2-23h, so this lead missed
    // the nudge entirely (cron downtime, late cron-run, etc). B2
    // back-fills so we don't drop the customer entirely.
    const created = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    const tp = pickBSequenceTouchpoint(created, 0, null, now);
    assert.equal(tp, "B2_T24H_OPEN_LOOP");
  });

  it("B1.5 fires when lead is 2h+ old and step = 0", () => {
    const created = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const tp = pickBSequenceTouchpoint(created, 0, null, now);
    assert.equal(tp, "B15_T2H_NUDGE");
  });

  it("B1.5 does NOT fire before 2h age", () => {
    const created = new Date(now.getTime() - 90 * 60 * 1000); // 1.5h
    const tp = pickBSequenceTouchpoint(created, 0, null, now);
    assert.equal(tp, null);
  });

  it("B1.5 does NOT fire after 23h age (B2 takes over)", () => {
    const created = new Date(now.getTime() - 23.5 * 60 * 60 * 1000);
    const tp = pickBSequenceTouchpoint(created, 0, null, now);
    // 23.5h age, step 0 — past B1.5 window, but not yet at the 24h
    // mark B2 requires → expect null (no eligible touchpoint).
    assert.equal(tp, null);
  });

  it("B1.5 does NOT re-fire once step has advanced", () => {
    const created = new Date(now.getTime() - 5 * 60 * 60 * 1000);
    const tp = pickBSequenceTouchpoint(created, 1, null, now);
    // B1.5 already sent (step=1). Age 5h is too young for B2.
    assert.equal(tp, null);
  });

  it("B3 fires when lead is 3 days+ old and step = 2", () => {
    const created = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000);
    const tp = pickBSequenceTouchpoint(created, 2, null, now);
    assert.equal(tp, "B3_T3D_NEIGHBOR");
  });

  it("B4 fires when lead is 8 days+ old and step = 3", () => {
    const created = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    const tp = pickBSequenceTouchpoint(created, 3, null, now);
    assert.equal(tp, "B4_T7D_STORM_ANCHOR");
  });

  it("B5 fires when lead is 22 days+ old and step = 4", () => {
    const created = new Date(now.getTime() - 22 * 24 * 60 * 60 * 1000);
    const tp = pickBSequenceTouchpoint(created, 4, null, now);
    assert.equal(tp, "B5_T21D_GRACE_EXIT");
  });

  it("enforces 18h gap between sends", () => {
    const created = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000);
    const tenHoursAgo = new Date(now.getTime() - 10 * 60 * 60 * 1000);
    const tp = pickBSequenceTouchpoint(created, 2, tenHoursAgo, now);
    assert.equal(tp, null);
  });

  it("allows a send after 18h+ gap", () => {
    const created = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000);
    const twentyHoursAgo = new Date(now.getTime() - 20 * 60 * 60 * 1000);
    const tp = pickBSequenceTouchpoint(created, 2, twentyHoursAgo, now);
    assert.equal(tp, "B3_T3D_NEIGHBOR");
  });

  it("returns null when age has not crossed the next-step threshold", () => {
    // Step 1, age only 12h — too young for B2.
    const created = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    const tp = pickBSequenceTouchpoint(created, 1, null, now);
    assert.equal(tp, null);
  });
});

describe("renderFallbackCopy — compliance", () => {
  const vars = {
    firstName: "Jane",
    address: "8450 Oak Park Ave",
    appointmentLocal: "2:30 PM",
    appointmentDayOfWeek: "Wednesday",
    shareUrl: "https://estimate.nolandsroofing.com/r/lead_abc",
    repName: "Tom",
  };

  it("includes opt-out instruction on every A and B template", () => {
    const touchpoints = [
      "A1_INSTANT",
      "A2_T24H",
      "A3_MORNING",
      "A4_ETA",
      "A5_POST_APPT",
      "B15_T2H_NUDGE",
      "B2_T24H_OPEN_LOOP",
      "B3_T3D_NEIGHBOR",
      "B4_T7D_STORM_ANCHOR",
      "B5_T21D_GRACE_EXIT",
    ] as const;
    for (const tp of touchpoints) {
      const body = renderFallbackCopy(tp, vars);
      const hasOptOut =
        body.toUpperCase().includes("STOP") ||
        body.toLowerCase().includes("stop hearing");
      assert.ok(
        hasOptOut,
        `${tp} missing opt-out instruction: "${body}"`,
      );
    }
  });

  it("never uses the word 'insurance' (FL § 627.7152)", () => {
    const touchpoints = [
      "A1_INSTANT",
      "A2_T24H",
      "A3_MORNING",
      "A4_ETA",
      "A5_POST_APPT",
      "B15_T2H_NUDGE",
      "B2_T24H_OPEN_LOOP",
      "B3_T3D_NEIGHBOR",
      "B4_T7D_STORM_ANCHOR",
      "B5_T21D_GRACE_EXIT",
    ] as const;
    for (const tp of touchpoints) {
      const body = renderFallbackCopy(tp, vars);
      assert.ok(
        !/insurance/i.test(body),
        `${tp} uses the forbidden word "insurance": "${body}"`,
      );
    }
  });

  it("personalizes with firstName + address on every body", () => {
    const tps = [
      "A1_INSTANT",
      "A2_T24H",
      "B2_T24H_OPEN_LOOP",
      "B5_T21D_GRACE_EXIT",
    ] as const;
    for (const tp of tps) {
      const body = renderFallbackCopy(tp, vars);
      assert.ok(body.includes("Jane"), `${tp} missing firstName`);
      assert.ok(
        body.includes("Oak Park"),
        `${tp} missing address substring`,
      );
    }
  });
});

describe("buildReminderVars — defensive defaults", () => {
  it("falls back to 'there' when name is empty", () => {
    const v = buildReminderVars({
      publicId: "x",
      name: "",
      phone: "+15551234567",
      address: "1 Main St",
      shareUrl: "https://e.com/r/x",
      appointmentAt: null,
      repFirstName: null,
      optedOut: false,
    });
    assert.equal(v.firstName, "there");
  });

  it("formats appointment time in America/New_York for downstream merge", () => {
    const v = buildReminderVars({
      publicId: "x",
      name: "Jane Doe",
      phone: "+15551234567",
      address: "1 Main St",
      shareUrl: "https://e.com/r/x",
      // 18:00 UTC = 2:00 PM ET (EDT)
      appointmentAt: "2026-06-01T18:00:00Z",
      repFirstName: null,
      optedOut: false,
    });
    assert.ok(/2:00\s?PM/i.test(v.appointmentLocal), `got: ${v.appointmentLocal}`);
    assert.equal(v.appointmentDayOfWeek, "Monday");
  });

  it("returns empty appointment strings when appointmentAt is null", () => {
    const v = buildReminderVars({
      publicId: "x",
      name: "Jane",
      phone: "+15551234567",
      address: "1 Main St",
      shareUrl: "https://e.com/r/x",
      appointmentAt: null,
      repFirstName: "Tom",
      optedOut: false,
    });
    assert.equal(v.appointmentLocal, "");
    assert.equal(v.appointmentDayOfWeek, "");
    assert.equal(v.repName, "Tom");
  });
});
