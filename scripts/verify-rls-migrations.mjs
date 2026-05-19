#!/usr/bin/env node
/**
 * Static check: tenant tables in migrations must enable RLS and define
 * office-scoped SELECT policies. Runs in CI without a live Supabase URL.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "migrations");

const TENANT_TABLES = ["offices", "users", "leads", "proposals", "calls", "events", "consents"];

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

let sql = "";
for (const f of files) {
  sql += readFileSync(join(migrationsDir, f), "utf8") + "\n";
}

const errors = [];

const normalized = sql.replace(/\s+/g, " ").toLowerCase();

for (const table of TENANT_TABLES) {
  const enablePhrase = `alter table public.${table} enable row level security`;
  if (!normalized.includes(enablePhrase)) {
    errors.push(`missing: enable row level security on public.${table}`);
  }
  const selectPolicy = new RegExp(
    `create policy [^;]+ on public\\.${table}[^;]* for select`,
    "i",
  );
  if (!selectPolicy.test(normalized)) {
    errors.push(`missing: SELECT policy on public.${table}`);
  }
}

if (!normalized.includes("current_office_id()")) {
  errors.push("missing: current_office_id() helper");
}

if (errors.length) {
  console.error("RLS migration verification failed:\n");
  for (const e of errors) console.error("  -", e);
  process.exit(1);
}

console.log(`RLS migration verification passed (${files.length} files, ${TENANT_TABLES.length} tenant tables).`);
