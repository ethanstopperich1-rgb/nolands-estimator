/**
 * scripts/jn-backfill.ts — push existing Supabase leads to JobNimbus.
 *
 * Why this exists:
 *   Production has 101 leads in Supabase but 0 of them have
 *   jobnimbus_contact_id populated — meaning Noland's reps see nothing
 *   in JN even though leads are flowing into our DB. Root cause: the
 *   JN push only runs inside /api/gemini-roof V3 (after painted-roof
 *   completes), AND it was dormant before JOBNIMBUS_API_KEY landed in
 *   Vercel. Leads created during that window never got the push.
 *
 *   This script backfills them: for every lead without a jnid, we
 *   findContactByPhone → createContact (if missing) → stamp the jnid
 *   on the Supabase row. After it runs, every existing lead has a
 *   JN counterpart and Noland's dashboards reflect the same population.
 *
 * Safe-by-default modes:
 *   --dry-run            : print actions, don't write anything
 *   --only-with-estimate : only push leads where estimate_low IS NOT
 *                          NULL (the "real-shaped" 30, skip the 71
 *                          step-1 abandons + obvious test data)
 *   --limit N            : cap iterations (default 100)
 *
 * Idempotent:
 *   findContactByPhone runs first → if the homeowner already lives in
 *   JN we reuse that jnid rather than create a duplicate. Re-running
 *   the script is a no-op for already-stamped rows.
 *
 * Usage:
 *   vercel env pull .env.local
 *   npx tsx scripts/jn-backfill.ts --only-with-estimate --limit 30
 *   npx tsx scripts/jn-backfill.ts            # full mode (all rows)
 *   npx tsx scripts/jn-backfill.ts --dry-run  # see what would happen
 */

import { createClient } from "@supabase/supabase-js";
import * as jn from "../lib/jobnimbus";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const onlyWithEstimate = args.has("--only-with-estimate");
const limitIdx = process.argv.indexOf("--limit");
const limit =
  limitIdx >= 0 && process.argv[limitIdx + 1]
    ? Math.max(1, Math.min(500, parseInt(process.argv[limitIdx + 1]!, 10)))
    : 100;

// Read env from .env.local (Vercel-pulled). We don't import dotenv
// here — the user runs this with `npx tsx -r dotenv/config` or sets
// the vars in their shell. We just check they exist.
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const JN_KEY = process.env.JOBNIMBUS_API_KEY ?? "";

function fatal(msg: string): never {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!SUPABASE_URL) fatal("SUPABASE_URL not set in env");
if (!SUPABASE_SERVICE_ROLE_KEY) fatal("SUPABASE_SERVICE_ROLE_KEY not set in env");
if (!JN_KEY) fatal("JOBNIMBUS_API_KEY not set in env");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function main(): Promise<void> {
  console.log(
    `\n🔧 jn-backfill — dryRun=${dryRun} onlyWithEstimate=${onlyWithEstimate} limit=${limit}\n`,
  );

  // 1. Find Noland's office id
  const { data: office, error: officeErr } = await supabase
    .from("offices")
    .select("id, slug, display_name")
    .eq("slug", "nolands")
    .maybeSingle();
  if (officeErr || !office) fatal(`office lookup failed: ${officeErr?.message ?? "not found"}`);
  console.log(`📍 Office: ${office.display_name} (${office.slug}) id=${office.id}\n`);

  // 2. Find leads without a jnid
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = (supabase as any)
    .from("leads")
    .select(
      "id, public_id, name, phone, email, address, zip, city, state, " +
        "estimate_low, estimate_high, voice_consent, preferred_language, " +
        "jobnimbus_contact_id, created_at",
    )
    .eq("office_id", office.id)
    .is("jobnimbus_contact_id", null);
  if (onlyWithEstimate) query = query.not("estimate_low", "is", null);
  query = query.order("created_at", { ascending: false }).limit(limit);
  const { data: leads, error: leadsErr } = await query;
  if (leadsErr) fatal(`leads query failed: ${leadsErr.message}`);
  if (!leads || leads.length === 0) {
    console.log("✅ Nothing to backfill — every matching lead already has a jnid.\n");
    return;
  }
  console.log(`📊 Found ${leads.length} leads without a jnid\n`);

  // 3. Loop — find or create in JN, then stamp
  let created = 0;
  let found = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of leads) {
    const l = row as {
      id: string;
      public_id: string;
      name: string | null;
      phone: string | null;
      email: string | null;
      address: string | null;
      zip: string | null;
      city: string | null;
      state: string | null;
      estimate_low: number | null;
      estimate_high: number | null;
      voice_consent: boolean | null;
      preferred_language: string | null;
    };
    const label = `${l.public_id.slice(0, 16)}… ${l.name ?? "(no name)"}`;
    if (!l.phone || !l.name) {
      console.log(`⏭️  ${label} — skip (no phone or name)`);
      skipped += 1;
      continue;
    }
    try {
      // a. Look up by phone first — avoid duplicates
      const search = await jn.findContactByPhone(l.phone);
      let jnid: string | null = null;
      let outcome = "";
      if (search.ok) {
        jnid = search.jnid;
        outcome = `found existing jnid=${jnid}`;
        found += 1;
      } else if (search.reason === "not_found") {
        // b. Create
        if (dryRun) {
          console.log(`🟡 ${label} — would CREATE in JN`);
          created += 1;
          continue;
        }
        const c = await jn.createContact({
          displayName: l.name,
          phone: l.phone,
          email: l.email ?? undefined,
          address: l.address ?? undefined,
          zip: l.zip ?? undefined,
          city: l.city ?? undefined,
          state: l.state ?? undefined,
          voiceConsent:
            l.voice_consent === true
              ? true
              : l.voice_consent === false
                ? false
                : undefined,
          language: l.preferred_language === "es" ? "es" : "en",
          tags: ["estimator", "nolands", "backfill"],
        });
        if (!c.ok) {
          console.log(
            `❌ ${label} — createContact failed: reason=${c.reason} ${c.error ?? ""}`,
          );
          failed += 1;
          continue;
        }
        jnid = c.jnid;
        outcome = `CREATED jnid=${jnid}`;
        created += 1;
      } else {
        console.log(
          `❌ ${label} — search failed: reason=${search.reason} ${search.error ?? ""}`,
        );
        failed += 1;
        continue;
      }

      // c. Stamp the jnid on the lead row
      if (dryRun) {
        console.log(`🟡 ${label} — ${outcome} (DRY RUN, no stamp)`);
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: updErr } = await (supabase as any)
        .from("leads")
        .update({ jobnimbus_contact_id: jnid })
        .eq("id", l.id);
      if (updErr) {
        console.log(`⚠️  ${label} — ${outcome} but stamp failed: ${updErr.message}`);
        failed += 1;
        continue;
      }
      console.log(`✅ ${label} — ${outcome}`);
    } catch (err) {
      console.log(`❌ ${label} — threw: ${err instanceof Error ? err.message : String(err)}`);
      failed += 1;
    }
  }

  console.log(`\n📈 Summary:`);
  console.log(`   Created in JN: ${created}`);
  console.log(`   Found existing: ${found}`);
  console.log(`   Skipped (no phone/name): ${skipped}`);
  console.log(`   Failed: ${failed}`);
  console.log(`   Total processed: ${leads.length}\n`);
}

main().catch((err) => {
  console.error("\n❌ fatal:", err);
  process.exit(1);
});
