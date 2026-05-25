-- 0023_lead_callback_dispatched.sql
--
-- CAL-2 — the missing link between the SMS slot pick (handleSlotPick)
-- and Sydney actually dialing the homeowner at the booked time.
--
-- Today (post 0022): A/B reply books a JN Measure Call task at
-- picked.iso, sets leads.appointment_at, and the podium-reminders
-- cron handles the A1-A5 reminder SMS sequence. But nothing dispatches
-- Sydney at the appointment_at instant. A homeowner who books "Wed 9am
-- via SMS" gets reminder texts but no actual call.
--
-- This column closes that gap. The /api/cron/scheduled-callback job
-- (every 5 min) finds leads with appointment_at in [now-2min, now+5min]
-- where callback_dispatched_at IS NULL, POSTs the existing
-- /api/dispatch-outbound endpoint, and stamps callback_dispatched_at
-- on success. The NULL check + the stamp form the idempotency guard:
-- duplicate cron firings can't dial the same homeowner twice.
--
-- Why a column instead of Redis: dispatched-state is durable customer-
-- safety data. A Redis flush mid-day could re-fire calls to homeowners
-- whose appointment time already passed — that's a TCPA violation
-- waiting to happen. The leads table is the right home.
--
-- Soft-fail discipline: the cron reads from this column; when it's
-- NULL the dispatch fires; on success it stamps the timestamp. If the
-- column ever needs to be reset (e.g., manual re-dial after a missed
-- call), set it back to NULL via Supabase Studio.
--
-- Safe to apply in any order vs 0022 — additive only, no destructive
-- changes, no foreign keys, no rewrites.
--
-- Apply: Supabase MCP was still timing out at apply time (May 2026,
-- same as 0022). Run the SQL below via Supabase Studio SQL Editor or
-- `supabase db query` once MCP recovers. The cron will throw caught
-- + logged SQL errors every 5 min until the column exists — no
-- homeowner impact (the dispatch never fires).

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS callback_dispatched_at TIMESTAMPTZ;

COMMENT ON COLUMN public.leads.callback_dispatched_at IS
  'When the /api/cron/scheduled-callback job successfully POSTed /api/dispatch-outbound for this lead. NULL = not yet dispatched. Idempotency guard against duplicate cron firings re-dialing the same homeowner. Reset to NULL via Supabase Studio to allow a manual re-dial.';

-- Partial index — only rows currently in the "appointment booked but
-- not yet dialed" state get indexed. Cron query reads exactly this
-- shape so the scan stays tiny relative to the full leads table.
-- Mirrors the partial-index pattern from 0020_reminder_sequences.sql
-- (leads_appointment_at_idx).
CREATE INDEX IF NOT EXISTS leads_callback_pending_idx
  ON public.leads (appointment_at)
  WHERE appointment_at IS NOT NULL
    AND callback_dispatched_at IS NULL
    AND reminder_opted_out = FALSE;

-- RLS — already on leads via 0002_rls_policies.sql. The new column
-- inherits the existing per-office policies. No new policy needed.
