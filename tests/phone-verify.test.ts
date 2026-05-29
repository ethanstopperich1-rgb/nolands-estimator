import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { verifyDialable } from "../lib/phone-verify";

/**
 * The dialability gate is DEFENSE-IN-DEPTH, not a hard boundary. The
 * load-bearing invariant: a Twilio-creds outage (or unset creds in
 * dev / preview) must NEVER block a legitimate dial. If creds are
 * absent, verifyDialable soft-fails OPEN (ok: true) and never touches
 * the live Lookup API.
 */
describe("phone-verify · soft-fail open", () => {
  let savedSid: string | undefined;
  let savedToken: string | undefined;
  let savedFlag: string | undefined;

  beforeEach(() => {
    savedSid = process.env.TWILIO_ACCOUNT_SID;
    savedToken = process.env.TWILIO_AUTH_TOKEN;
    savedFlag = process.env.TWILIO_LOOKUP_ENABLED;
    // Simulate a creds outage / unconfigured dev environment.
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_LOOKUP_ENABLED;
  });

  afterEach(() => {
    if (savedSid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
    else process.env.TWILIO_ACCOUNT_SID = savedSid;
    if (savedToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = savedToken;
    if (savedFlag === undefined) delete process.env.TWILIO_LOOKUP_ENABLED;
    else process.env.TWILIO_LOOKUP_ENABLED = savedFlag;
  });

  it("returns ok:true when Twilio creds are unset (never blocks a dial)", async () => {
    const result = await verifyDialable("+14075551234");
    assert.equal(result.ok, true);
    assert.equal(result.reason, "lookup_unavailable");
    assert.equal(result.lineType, null);
  });

  it("soft-passes empty input without throwing", async () => {
    const result = await verifyDialable("");
    assert.equal(result.ok, true);
    assert.equal(result.reason, "lookup_unavailable");
  });
});
