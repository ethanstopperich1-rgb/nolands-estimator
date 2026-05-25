-- 0024_lead_city_state.sql
--
-- FUNNEL-2 — extract city + state from Google Places autocomplete
-- and persist them as first-class columns on the lead row.
--
-- Before this column pair landed, the leads table held `address` (full
-- formatted string) + `zip` (text). When /api/gemini-roof V3 pushed the
-- contact to JobNimbus, only `zip` got mapped to JN's dedicated `zip`
-- column — JN was left to parse the rest of the address string itself,
-- which it does inconsistently. Reps in JN couldn't filter the contacts
-- list by city without a manual address-string parse.
--
-- The Google Places autocomplete already returns address_components on
-- every place_changed event. This migration unlocks two changes that
-- ship together:
--   1. Client extracts locality + administrative_area_level_1.short_name
--      from address_components and posts them with the lead.
--   2. /api/leads + quick-capture write city + state on the lead row.
--   3. /api/gemini-roof V3 → JN createContact passes city + state_text
--      through to JobNimbus so reps can filter the contacts list by
--      city in JN directly.
--
-- Both columns are nullable — pre-FUNNEL-2 lead rows have no city/state,
-- and Places sometimes returns partial address_components for rural
-- addresses (no locality match). The downstream code already treats
-- these as optional.
--
-- Safe to apply in any order vs 0022 / 0023 — additive only, no
-- destructive changes, no foreign keys, no rewrites.
--
-- Apply via psql:
--   psql "<session-pooler-url>" -f migrations/0024_lead_city_state.sql

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS state TEXT;

COMMENT ON COLUMN public.leads.city IS
  'City extracted from Google Places address_components (locality field). Maps to JN contact.city. Nullable — Places may not return locality for rural addresses.';

COMMENT ON COLUMN public.leads.state IS
  'US state postal abbreviation (FL, GA, etc.) extracted from Google Places address_components (administrative_area_level_1.short_name). Maps to JN contact.state_text. Nullable for the same reason as city.';

-- Index for the dashboard "leads by city" filter that ships in a
-- follow-up. Partial — only rows where city is set, keeps the index
-- small. Mirrors the leads_office_created_idx + appointment_at_idx
-- partial-index pattern.
CREATE INDEX IF NOT EXISTS leads_office_city_idx
  ON public.leads (office_id, city)
  WHERE city IS NOT NULL;

-- RLS — already on leads via 0002_rls_policies.sql. The new columns
-- inherit the existing per-office policies. No new policy needed.
