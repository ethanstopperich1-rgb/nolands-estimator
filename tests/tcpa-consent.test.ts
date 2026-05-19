import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildMarketingConsentText,
  buildVoiceConsentDisclosureText,
  MARKETING_CONSENT_TEMPLATE,
} from "../lib/tcpa-consent";

describe("tcpa-consent", () => {
  it("substitutes office name in marketing text", () => {
    const text = buildMarketingConsentText("Noland's Roofing");
    assert.ok(text.includes("Noland's Roofing"));
    assert.ok(!text.includes("{{office_name}}"));
    assert.ok(!text.includes("partner contractors"));
  });

  it("falls back when office name empty", () => {
    const text = buildMarketingConsentText("   ");
    assert.ok(text.includes("Voxaris"));
  });

  it("keeps template placeholder documented", () => {
    assert.ok(MARKETING_CONSENT_TEMPLATE.includes("{{office_name}}"));
  });

  it("builds voice disclosure", () => {
    const text = buildVoiceConsentDisclosureText("Acme Roofing LLC");
    assert.ok(text.includes("Acme Roofing LLC"));
  });

  it("voice disclosure discloses AI voice (FCC Feb 2024 ruling)", () => {
    // FCC declaratory ruling on AI-generated voice (8 Feb 2024) classes
    // AI / synthetic voice as "artificial voice" under the TCPA — must
    // be disclosed at consent. If this assertion ever fails, the
    // disclosure is non-compliant and the next outbound call is illegal.
    const text = buildVoiceConsentDisclosureText("Acme Roofing LLC");
    assert.ok(
      /\bAI\b/.test(text) && /voice/i.test(text),
      "Voice consent disclosure must explicitly disclose AI voice — required by FCC Feb 2024 ruling",
    );
  });

  it("voice disclosure offers an opt-out path", () => {
    // TCPA requires a way to revoke consent. STOP keyword for SMS,
    // verbal "remove me" for the call itself. Both must appear in the
    // captured disclosure text so the audit row reflects what the
    // customer agreed to.
    const text = buildVoiceConsentDisclosureText("Acme Roofing LLC");
    assert.ok(
      /stop/i.test(text) && /remove/i.test(text),
      "Voice consent disclosure must include both opt-out mechanisms (STOP + remove me)",
    );
  });
});
