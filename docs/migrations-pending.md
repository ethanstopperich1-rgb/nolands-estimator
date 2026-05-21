# Pending Supabase Migrations

Two migrations are committed to the repo but not yet applied to the
production database. They're SAFE to run in any order — both add
columns/tables with `IF NOT EXISTS` guards and have no destructive
side effects.

## How to apply

1. Open [Supabase dashboard](https://app.supabase.com) → SQL Editor
2. Paste each migration body below
3. Click **Run**
4. Verify with the post-apply check at the bottom

The MCP-based `apply_migration` flow has timed out repeatedly this
session, so paste-and-run via the dashboard is the reliable path.

---

## Migration 0018 — Gemini per-office cost cap

**File**: `migrations/0018_gemini_cost_counter.sql`

**Adds**:
- `offices.daily_image_cap` column (INTEGER, default 25)
- `gemini_calls` table — append-only audit trail for cost accounting
- `gemini_calls_today(office_id)` RPC for the hot-path rate check
- RLS policies on `gemini_calls` (same office_id model as the rest)

**What it does live**: When applied, `/api/gemini-roof` will start
rejecting requests with HTTP 429 once an office exceeds its daily
cap (default 25 Pro Image calls/day = ~$3.35/day). Before applied,
the soft-fail in `lib/gemini-cost-cap.ts` returns "allowed" on every
call (no DB to query).

**Risk**: Low. Adds new column + new table. No existing data
touched. Disable via `vercel env add GEMINI_COST_CAP_DISABLED=1`
if any issue surfaces.

---

## Migration 0019 — Lead → JobNimbus contact_id linkage

**File**: `migrations/0019_lead_jobnimbus_contact.sql`

**Adds**:
- `leads.jobnimbus_contact_id` column (TEXT, nullable)
- Partial index on the column WHERE NOT NULL

**What it does live**: When applied, the JN push at
`/api/gemini-roof` V3 success can stash the returned `jnid` on the
lead row. Sydney's `book_inspection` (via dispatch-outbound metadata)
will then reuse that contact_id instead of creating a duplicate JN
record. Before applied, the cast-through-unknown in route.ts logs a
warning but doesn't crash.

**Risk**: Low. Adds a nullable column. No existing data touched.

---

## Post-apply check

After both migrations are applied, run this in the SQL editor to
confirm:

```sql
-- Confirm 0018: gemini_calls table + daily_image_cap column present
SELECT
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'gemini_calls') AS m0018_table,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'offices' AND column_name = 'daily_image_cap') AS m0018_column,
  EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gemini_calls_today') AS m0018_rpc,
  -- Confirm 0019: jobnimbus_contact_id on leads
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'jobnimbus_contact_id') AS m0019_column;
```

All four should return `t`.

---

## Regenerate Supabase TypeScript types

Once both migrations are applied, regenerate the types so the
existing `cast through unknown` patches in
`lib/gemini-cost-cap.ts` + `app/api/gemini-roof/route.ts` can be
cleaned up in a follow-up PR:

```bash
npx supabase gen types typescript --project-id <PROJECT_ID> > types/supabase.ts
```

The cast-through-unknown patches are harmless to leave in place —
they just lose a layer of type-safety on those specific column
references. Schedule the cleanup but don't block on it.
