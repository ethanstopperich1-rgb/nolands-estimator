/**
 * Smoke test: contractor-intel scoring via subprocess (Python).
 * Run: npm test -- tests/contractor-intel-score.test.ts
 */
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const VENV_PY = path.join(ROOT, ".venv-intel", "bin", "python");
const PY = existsSync(VENV_PY) ? VENV_PY : "python3";
const ENV = {
  ...process.env,
  PYTHONPATH: path.join(ROOT, "scripts/contractor-intel"),
};

test("dbpr filter yields CCC prospects from cached extract", () => {
  const csv = path.join(ROOT, "data/contractor-intel/dbpr/CONSTRUCTIONLICENSE_1_latest.csv");
  if (!existsSync(csv)) {
    console.log("skip dbpr filter test — no cached CSV");
    return;
  }
  const code = `
from pathlib import Path
from dbpr_fetch import parse_dbpr_csv
from dbpr_filter import filter_roofing_prospects
rows = parse_dbpr_csv(Path("${csv.replace(/\\/g, "\\\\")}"))
prospects = filter_roofing_prospects(rows, metros=["orlando"])
assert len(prospects) > 100, len(prospects)
assert prospects[0].occupation_code == "CCC"
print("ok", len(prospects))
`;
  const r = spawnSync(PY, ["-c", code], { cwd: ROOT, env: ENV, encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test("score_prospect ranks email + title highly", () => {
  const code = `
from models import ContractorProspect
from score import score_prospect, rank_prospects

p = ContractorProspect(
  license_number="CCC999",
  occupation_code="CCC",
  dba_name="Acme Roofing",
  city="Orlando",
  state="FL",
  email="owner@acmeroofing.com",
  email_confidence="high",
  contact_title="Owner",
  website="https://acmeroofing.com",
  signals={"metro": "orlando"},
)
score_prospect(p)
assert p.lead_score >= 55, p.lead_score
assert p.enrichment_status == "export_ready"
print("ok", p.lead_score)
`;
  const r = spawnSync(PY, ["-c", code], { cwd: ROOT, env: ENV, encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /ok/);
});
