-- 0021_widen_consent_type_check.sql
--
-- Widen the consents.consent_type CHECK constraint so it accepts every
-- value the codebase actually writes. The production constraint as of
-- May 2026 was rejecting "call_recording" (Postgres 23514) which broke
-- the voice-consent flow on the result page — homeowner clicks
-- "LOCK IN MY REAL NUMBER" and the consent INSERT 500s.
--
-- The original 0001_initial_schema.sql LISTS the intended values in a
-- comment (`'tcpa_marketing' | 'call_recording' | 'sms' | 'email_marketing'`)
-- but never actually declared a CHECK constraint. Someone added a
-- stricter CHECK to production out-of-band; this migration drops it
-- and rebuilds with the full vocabulary the codebase needs.
--
-- Codebase audit (May 2026):
--   tcpa_marketing   → /api/leads form-submit marketing consent
--   call_recording   → /api/leads voice-callback inline +
--                      /api/leads/[publicId]/voice-consent (this was
--                      the failing path)
--   voice_sms_yes    → /api/sms/inbound YES-keyword consent receipt
--   sms              → reserved for future general-SMS consents
--   email_marketing  → reserved for future email opt-in consents
--
-- All five are valid TCPA / FCC audit-trail categories. After this
-- migration applies, also revert the voice-consent route to
-- consent_type="call_recording" + restore the matching idempotency
-- check (search for "Migration 0021 will widen" in the route file).
--
-- HOW TO APPLY (Supabase MCP pooler was timing out at write time):
--   1. Open Supabase Dashboard → SQL Editor → New Query
--   2. Paste the ALTER TABLE block below
--   3. Run. Should return "ALTER TABLE" twice.
--   4. Once green, push the route revert (changes the consent_type
--      back to "call_recording" + restores the matching idempotency
--      lookup).

ALTER TABLE public.consents
  DROP CONSTRAINT IF EXISTS consents_consent_type_check;

ALTER TABLE public.consents
  ADD CONSTRAINT consents_consent_type_check
  CHECK (consent_type IN (
    'tcpa_marketing',
    'call_recording',
    'voice_sms_yes',
    'sms',
    'email_marketing'
  ));
