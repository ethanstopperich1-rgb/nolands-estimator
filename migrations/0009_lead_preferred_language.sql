-- 0009_lead_preferred_language.sql — bilingual homeowner journey.
--
-- The customer-facing estimator at `/` exposes an EN ↔ ES language
-- toggle. Whichever language the homeowner is on when they submit
-- gets persisted to the lead row. All downstream comms then localize:
--   - The confirmation SMS body (Spanish vs English)
--   - The /r/[publicId] share-page render
--   - Sydney's voice greeting + the FCC AI-voice consent disclosure
--     ("AI voice assistant" / "asistente de voz AI")
--   - The post-call follow-up SMS
--
-- Internal operator messages (rep new-lead alerts, dashboard UI,
-- LeadReport, drawer, etc.) stay English — the rep team works in
-- English even when their leads are Spanish-preferring.
--
-- ── Why a column, not just a session cookie ──
--
-- The lead row outlives the homeowner's browser session. When the
-- rep follows up tomorrow, when the lead-webhook fires to Podium,
-- when /r/[publicId] gets shared with the spouse — every one of
-- those touchpoints needs to know the homeowner's language. Storing
-- on the lead row is the only place it's reliably available.

begin;

alter table public.leads
  add column if not exists preferred_language text not null default 'en'
    check (preferred_language in ('en', 'es'));

comment on column public.leads.preferred_language is
  'ISO 639-1 language preference captured at submission time. Drives downstream comm localization (SMS body, share-page render, Sydney voice prompt + AI-voice consent disclosure). Default ''en''; ''es'' when homeowner toggled Spanish before submit. Internal rep tooling stays English regardless.';

commit;
