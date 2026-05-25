#!/usr/bin/env node
/**
 * Static check: every service-role insert / upsert into a tenant-scoped
 * table MUST include an `office_id` field in the same object literal.
 *
 * Why this matters: the service-role client BYPASSES RLS. Without an
 * explicit office_id on every write, a bug that omits the tag silently
 * leaks rows across tenants — there's no RLS net to catch the mistake.
 *
 * Runs in CI without a live Supabase URL. Greps source files for the
 * patterns `.from("<tenant>").insert({...})` and `.upsert({...})`,
 * verifies `office_id` appears within the same call expression.
 *
 * Limitations:
 *   - Static text analysis. Won't catch every edge case (e.g. spread
 *     operators that conditionally include office_id). Best-effort
 *     defense-in-depth.
 *   - Only checks service-role usage. Server/browser clients respect
 *     RLS and don't need this check.
 *   - To exempt a callsite, add `// office-id-check: ok-reason` on
 *     the .insert or .upsert line.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

// Tenant-scoped tables — every row has an office_id FK to public.offices.
// Match the list in scripts/verify-rls-migrations.mjs + newer additions.
const TENANT_TABLES = [
  "offices",
  "users",
  "leads",
  "proposals",
  "calls",
  "events",
  "consents",
  "sms_opt_outs",
  "canvass_targets",
  "canvass_outcomes",
  "contractor_prospects",
  "parcels",
  "storm_events",
  "gemini_calls",
];

// Walk app/ + lib/ + scripts/ for .ts and .tsx files.
const SEARCH_DIRS = ["app", "lib", "scripts"];
const EXTS = [".ts", ".tsx", ".mjs"];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next" || e.name.startsWith(".")) continue;
      walk(full, out);
    } else if (EXTS.some((ext) => e.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

const files = SEARCH_DIRS.flatMap((d) => walk(join(repoRoot, d)));

const errors = [];

for (const file of files) {
  const content = readFileSync(file, "utf8");

  // Skip files that don't even reference the service-role client.
  if (!content.includes("createServiceRoleClient")) continue;

  // For each tenant table, look for .from("<table>").insert(...) or .upsert(...)
  for (const table of TENANT_TABLES) {
    // The "offices" table itself contains the office_id column? No — offices.id
    // IS the office_id. Inserts on offices CREATE a new office and are admin-
    // gated separately. Skip the office_id check on offices inserts.
    if (table === "offices") continue;

    const fromRe = new RegExp(
      `\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)`,
      "g",
    );
    let match;
    while ((match = fromRe.exec(content)) !== null) {
      const startIdx = match.index;
      // Look ahead within the next ~800 chars for an .insert( or .upsert(
      // call expression chained off this .from() handle.
      const window = content.slice(startIdx, startIdx + 1200);
      const writeMatch = window.match(/\.(insert|upsert)\s*\(/);
      if (!writeMatch) continue;

      const writeStart = startIdx + writeMatch.index;
      // Find the matching closing paren for the .insert( / .upsert( call —
      // this gives us the FULL call expression including the row literal(s).
      const callBlock = readBalanced(content, writeStart + writeMatch[0].length);
      if (!callBlock) continue;

      // Check exemption marker within ±3 lines of the insert/upsert.
      // Same-line markers are awkward when the call spans multiple
      // lines (a typical .insert({...}, { onConflict }) block), so
      // we widen the window to a small contextual band.
      const beforeIdx = nthPreviousNewline(content, writeStart, 3);
      const afterIdx = nthNextNewline(content, writeStart, 3);
      const band = content.slice(beforeIdx, afterIdx);
      if (/office-id-check:\s*ok/i.test(band)) continue;

      // Pass if the call expression includes "office_id" as a property key.
      // Match either:
      //   office_id: ...
      //   office_id, (spread shorthand)
      //   ...spread that probably includes it (best-effort tolerate)
      const hasOfficeId =
        /\boffice_id\s*[:,]/.test(callBlock) ||
        /\.\.\.\w+/.test(callBlock); // spread → tolerate (caller responsible)

      if (!hasOfficeId) {
        const lineNum = content.slice(0, writeStart).split("\n").length;
        errors.push(
          `${file.replace(repoRoot + "/", "")}:${lineNum} — .${writeMatch[1]}() on "${table}" without office_id`,
        );
      }
    }
  }
}

if (errors.length) {
  console.error("Office-id-tagging verification failed — service-role writes must include office_id:\n");
  for (const e of errors) console.error("  -", e);
  console.error(
    "\nFix by adding `office_id: officeId` to the row literal, OR add `// office-id-check: ok-<reason>` on the .insert/.upsert line to exempt.",
  );
  process.exit(1);
}

console.log(
  `Office-id-tagging verification passed (${files.length} files scanned, ${TENANT_TABLES.length - 1} tenant tables checked).`,
);

function nthPreviousNewline(s, from, n) {
  let i = from;
  for (let k = 0; k < n; k++) {
    const next = s.lastIndexOf("\n", i - 1);
    if (next === -1) return 0;
    i = next;
  }
  return i;
}

function nthNextNewline(s, from, n) {
  let i = from;
  for (let k = 0; k < n; k++) {
    const next = s.indexOf("\n", i + 1);
    if (next === -1) return s.length;
    i = next;
  }
  return i;
}

/**
 * Read characters starting at `start`, balancing parens, until the
 * outer parenthesis closes. Returns the contents between the parens
 * (exclusive of the outer parens themselves).
 */
function readBalanced(s, start) {
  let depth = 1;
  let i = start;
  while (i < s.length && depth > 0) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === '"' || c === "'" || c === "`") {
      // Skip strings (with simple escape handling).
      const quote = c;
      i++;
      while (i < s.length && s[i] !== quote) {
        if (s[i] === "\\") i++;
        i++;
      }
    }
    i++;
  }
  if (depth !== 0) return null;
  return s.slice(start, i - 1);
}
