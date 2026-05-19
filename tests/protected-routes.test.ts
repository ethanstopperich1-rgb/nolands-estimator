import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isProtected,
  PUBLIC_LEAD_SUBROUTES,
} from "../lib/protected-routes";

describe("isProtected", () => {
  it("allows public lead capture", () => {
    assert.equal(isProtected("/api/leads", "POST"), false);
  });

  it("allows voice-consent sub-route", () => {
    assert.ok(PUBLIC_LEAD_SUBROUTES.has("voice-consent"));
    assert.equal(
      isProtected("/api/leads/lead_0123456789abcdef0123456789abcdef/voice-consent", "POST"),
      false,
    );
  });

  it("protects rep lead sub-routes", () => {
    assert.equal(
      isProtected("/api/leads/lead_0123456789abcdef0123456789abcdef/roof-v3", "POST"),
      true,
    );
  });

  it("protects dashboard pages", () => {
    assert.equal(isProtected("/dashboard/leads", "GET"), true);
  });

  it("allows public gemini-roof", () => {
    assert.equal(isProtected("/api/gemini-roof", "GET"), false);
  });

  it("protects POST proposals", () => {
    assert.equal(isProtected("/api/proposals", "POST"), true);
    assert.equal(isProtected("/api/proposals/abc123", "GET"), false);
  });
});
