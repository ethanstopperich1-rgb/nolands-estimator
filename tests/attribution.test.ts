import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composeSource, parseAttribution } from "../lib/attribution";

describe("composeSource", () => {
  it("utm_source → source / medium / campaign", () => {
    assert.equal(
      composeSource(
        {
          utm_source: "google",
          utm_medium: "cpc",
          utm_campaign: "spring-roof",
        },
        "estimator",
      ),
      "google / cpc / spring-roof",
    );
  });

  it("utm_source with missing medium/campaign fills dashes", () => {
    assert.equal(
      composeSource({ utm_source: "newsletter" }, "estimator"),
      "newsletter / - / -",
    );
  });

  it("gclid → google ads (when no utm_source)", () => {
    assert.equal(
      composeSource({ gclid: "abc123" }, "estimator"),
      "google ads",
    );
  });

  it("fbclid → facebook ads (when no utm_source/gclid)", () => {
    assert.equal(
      composeSource({ fbclid: "fb_xyz" }, "estimator"),
      "facebook ads",
    );
  });

  it("utm_source wins over gclid + fbclid", () => {
    assert.equal(
      composeSource(
        { utm_source: "bing", gclid: "g", fbclid: "f" },
        "estimator",
      ),
      "bing / - / -",
    );
  });

  it("external referrer → referral: host", () => {
    assert.equal(
      composeSource(
        { referrer: "https://www.facebook.com/some/path?x=1" },
        "estimator",
      ),
      "referral: www.facebook.com",
    );
  });

  it("own-site referrer falls through to fallback (not a real referral)", () => {
    assert.equal(
      composeSource(
        { referrer: "https://estimate.nolandsroofing.com/r/lead_abc" },
        "estimate.nolandsroofing.com",
      ),
      "estimate.nolandsroofing.com",
    );
  });

  it("no signals → falls back to provided fallback", () => {
    assert.equal(composeSource({}, "quick-capture"), "quick-capture");
  });

  it("no signals + no fallback → direct", () => {
    assert.equal(composeSource({}, null), "direct");
    assert.equal(composeSource({}, ""), "direct");
    assert.equal(composeSource({}), "direct");
  });

  it("caps the composed string at 80 chars", () => {
    const long = "x".repeat(300);
    const out = composeSource({ utm_source: long }, "estimator");
    assert.ok(out.length <= 80, `expected <=80, got ${out.length}`);
  });
});

describe("parseAttribution", () => {
  it("never throws on null / undefined / garbage", () => {
    assert.deepEqual(parseAttribution(null), {});
    assert.deepEqual(parseAttribution(undefined), {});
    assert.deepEqual(parseAttribution(42), {});
    assert.deepEqual(parseAttribution("a string"), {});
    assert.deepEqual(parseAttribution([1, 2, 3]), {});
    assert.deepEqual(parseAttribution(true), {});
  });

  it("keeps only allow-listed keys, drops unknown junk", () => {
    const out = parseAttribution({
      utm_source: "google",
      evil: "<script>alert(1)</script>",
      __proto__: "polluted",
      password: "hunter2",
    });
    assert.deepEqual(out, { utm_source: "google" });
    assert.ok(!("evil" in out));
    assert.ok(!("password" in out));
  });

  it("caps each field at 200 chars", () => {
    const out = parseAttribution({ utm_campaign: "y".repeat(500) });
    assert.equal(out.utm_campaign?.length, 200);
  });

  it("drops non-string values + empties, trims + collapses whitespace", () => {
    const out = parseAttribution({
      utm_source: 123, // non-string → dropped
      utm_medium: "  cpc  ", // trimmed
      utm_campaign: "spring   sale", // whitespace collapsed
      utm_content: "", // empty → dropped
      utm_term: "   ", // whitespace-only → dropped
    });
    assert.deepEqual(out, { utm_medium: "cpc", utm_campaign: "spring sale" });
  });

  it("round-trips through composeSource with sanitized values", () => {
    const parsed = parseAttribution({
      utm_source: "  Google  ",
      utm_medium: "cpc",
      utm_campaign: "roof-2026",
      junk: "x",
    });
    assert.equal(
      composeSource(parsed, "estimator"),
      "Google / cpc / roof-2026",
    );
  });
});
