/**
 * Unit tests for lib/sms-cold-start.ts — the "Text ROOF to 888" cold
 * funnel's parsing heuristics (the risky, deterministic bits).
 * Run: npx tsx --test tests/sms-cold-start.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isColdStartKeyword,
  looksLikeAddress,
  cleanFirstName,
} from "../lib/sms-cold-start";

test("isColdStartKeyword fires on the advertised keyword + intent synonyms", () => {
  for (const s of ["ROOF", "roof", " Roof ", "estimate", "inspection", "quote", "book"]) {
    assert.equal(isColdStartKeyword(s), true, `should trigger: "${s}"`);
  }
  // Mid-sentence / unrelated → let the LLM handle (no rigid funnel).
  for (const s of ["my roof leaks", "hello", "what do you charge", "yes", "A"]) {
    assert.equal(isColdStartKeyword(s), false, `should NOT trigger: "${s}"`);
  }
});

test("looksLikeAddress accepts real addresses, rejects names/affirmations", () => {
  for (const s of [
    "1033 Raining Meadows Lane",
    "123 Main St, Orlando FL",
    "456 Oak Avenue Clermont 34711",
    "789 SW 12th Ct",
  ]) {
    assert.equal(looksLikeAddress(s), true, `should look like an address: "${s}"`);
  }
  for (const s of ["John", "yes", "ok", "Mike Smith", "sounds good"]) {
    assert.equal(looksLikeAddress(s), false, `should NOT look like an address: "${s}"`);
  }
});

test("cleanFirstName strips lead-ins and title-cases the first token", () => {
  assert.equal(cleanFirstName("John"), "John");
  assert.equal(cleanFirstName("john"), "John");
  assert.equal(cleanFirstName("I'm Mike"), "Mike");
  assert.equal(cleanFirstName("my name is sarah"), "Sarah");
  assert.equal(cleanFirstName("this is Bob Smith"), "Bob");
  assert.equal(cleanFirstName("it's Dee"), "Dee");
});
