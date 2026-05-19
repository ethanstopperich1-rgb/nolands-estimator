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
});
