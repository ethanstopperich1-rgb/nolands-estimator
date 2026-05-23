import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hasMarketingConsent,
  isValidLeadPublicId,
  isValidOfficeSlug,
  normalizeOfficeSlug,
} from "../lib/leads/validation";

describe("leads validation", () => {
  it("validates lead public ids", () => {
    assert.ok(isValidLeadPublicId("lead_" + "a".repeat(32)));
    assert.equal(isValidLeadPublicId("lead_short"), false);
    assert.equal(isValidLeadPublicId(null), false);
  });

  it("normalizes office slug", () => {
    assert.equal(normalizeOfficeSlug("  Nolands  "), "nolands");
    assert.equal(normalizeOfficeSlug(undefined), "voxaris");
  });

  it("validates office slug shape", () => {
    assert.ok(isValidOfficeSlug("acme-roofing"));
    assert.equal(isValidOfficeSlug("x"), false);
  });

  it("detects marketing consent", () => {
    assert.ok(hasMarketingConsent({ marketingConsent: true }));
    assert.ok(hasMarketingConsent({ tcpaConsent: true }));
    assert.equal(hasMarketingConsent({}), false);
  });
});
