-- 0022_sms_offered_slots.sql
--
-- SMS scheduling state machine — persist the two time slots offered to
-- a homeowner when they reply YES/SCHEDULE to the estimate-ready MMS.
--
-- Runtime parity: today the inbound SMS handler stashes offered slots
-- on the Redis-backed SmsConversation (lib/sms-conversation.ts) with a
-- 24h TTL. That works for a single-instance deploy but isn't durable
-- across Redis purges or cross-instance reads in a high-volume world.
-- This column promotes the offer to first-class data, so:
--   - Slots survive Redis cache evictions
--   - Dashboards can show "offered window pending" without inspecting
--     a separate cache
--   - The 24h staleness check moves from "TTL on Redis" to a
--     deterministic timestamp compare against sms_offered_at
--
-- Shape: JSONB array of slot objects matching SlotOffer in
-- lib/sms-conversation.ts:
--   [
--     {"key": "A", "iso": "2026-05-27T09:00:00-04:00", "label": "Wed May 27, 9 AM-12 PM", "window": "morning"},
--     {"key": "B", "iso": "2026-05-28T13:00:00-04:00", "label": "Thu May 28, 1 PM-5 PM",  "window": "afternoon"}
--   ]
--
-- Soft-fail discipline: the inbound handler reads from this column
-- when present; falls back to the Redis SmsConversation when the
-- column is NULL (e.g. on a deploy where the column predates the
-- runtime code). Both layers can co-exist during phased rollout.
--
-- Apply: Supabase MCP was timing out at apply time (May 2026), so the
-- SQL below should be run via Supabase Studio SQL Editor or
-- `supabase db query` once MCP recovers.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS sms_offered_slots JSONB,
  ADD COLUMN IF NOT EXISTS sms_offered_at TIMESTAMPTZ;

-- Partial index — only rows currently in the "offer-pending" state get
-- indexed. Inbound A/B reply handler reads this exact shape (lookup
-- by phone WHERE sms_offered_slots IS NOT NULL), so the partial index
-- keeps the scan tiny relative to the full leads table.
CREATE INDEX IF NOT EXISTS idx_leads_sms_offered
  ON public.leads (phone)
  WHERE sms_offered_slots IS NOT NULL;

COMMENT ON COLUMN public.leads.sms_offered_slots IS
  'JSONB array of time slots offered to the homeowner via SMS after YES/SCHEDULE reply. Each entry has key/iso/label/window. Cleared after A/B reply books the JN Measure Call task.';

COMMENT ON COLUMN public.leads.sms_offered_at IS
  'When the slot offer was sent via SMS. Inbound handler treats offers older than 24h as stale and re-prompts with fresh slots.';

-- RLS — already on leads via 0002_rls_policies.sql. The new columns
-- inherit the existing per-office policies. No new policy needed.
