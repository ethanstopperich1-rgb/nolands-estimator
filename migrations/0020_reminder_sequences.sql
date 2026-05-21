-- 0020_reminder_sequences.sql
--
-- Adds the state machine columns for two reminder sequences:
--   - Sequence A (no-show prevention) — 5 touchpoints between booking
--     and the appointment time.
--   - Sequence B (abandoner nurture) — 5 touchpoints over 21 days for
--     leads who submitted the estimator but never booked.
--
-- The /api/cron/podium-reminders job (every 15 min) and
-- /api/cron/podium-abandoners job (hourly) read this state to decide
-- which touchpoint, if any, is eligible for each lead this tick.
--
-- Design notes:
--   * appointment_at + appointment_jn_job_id form a denormalized cache
--     of JobNimbus job.date_start. The cron polls JN's
--     search_jobs_by_date_range every run and upserts this cache, so
--     the homeowner-side reminder math doesn't pay a round-trip to JN
--     for every lead per tick. JN is the source of truth — drift
--     resolves on the next cron run.
--   * abandoner_step is an integer 0..5 that records the highest-
--     numbered abandoner touchpoint already sent. 0 = none yet; 5 =
--     fully nurtured. We never decrement; STOP/opt-out sets
--     reminder_opted_out = true and short-circuits all sends.
--   * reminder_opted_out is the universal opt-out gate. Podium's
--     platform-level STOP handling sets this via the inbound webhook
--     (PR2). Until then, ops can hand-toggle for compliance.
--   * All timestamp columns are nullable — NULL means "not yet sent".
--     Cron logic is "if NULL and clock-condition met → send and
--     stamp." Idempotent under retry.
--
-- Safe to apply in any order vs 0018 / 0019 — additive only, no
-- destructive changes, no foreign keys.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS appointment_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS appointment_jn_job_id TEXT,
  ADD COLUMN IF NOT EXISTS reminder_instant_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_t24h_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_morning_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_eta_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_post_appt_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS abandoner_step INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS abandoner_last_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_opted_out BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN leads.appointment_at IS
  'Cached JobNimbus job.date_start (UTC). NULL when no appointment booked. Cron re-syncs from JN every 15 min.';
COMMENT ON COLUMN leads.appointment_jn_job_id IS
  'JobNimbus job jnid that produced appointment_at. Allows re-sync on edit.';
COMMENT ON COLUMN leads.reminder_instant_sent_at IS
  'Sequence A1 — instant booking confirmation sent at this UTC time, else NULL.';
COMMENT ON COLUMN leads.reminder_t24h_sent_at IS
  'Sequence A2 — day-before reminder sent at this UTC time, else NULL.';
COMMENT ON COLUMN leads.reminder_morning_sent_at IS
  'Sequence A3 — morning-of reminder sent at this UTC time, else NULL.';
COMMENT ON COLUMN leads.reminder_eta_sent_at IS
  'Sequence A4 — 30-minute ETA reminder sent at this UTC time, else NULL.';
COMMENT ON COLUMN leads.reminder_post_appt_sent_at IS
  'Sequence A5 — post-appointment endowment follow-up sent at this UTC time, else NULL.';
COMMENT ON COLUMN leads.abandoner_step IS
  'Highest-numbered Sequence B touchpoint already sent. 0 = none; 5 = nurture complete.';
COMMENT ON COLUMN leads.abandoner_last_sent_at IS
  'When the most recent Sequence B touchpoint fired. Used for minimum-gap enforcement.';
COMMENT ON COLUMN leads.reminder_opted_out IS
  'True when the customer replied STOP / opted out. Hard gate — no reminder send ever fires when true.';

-- Index: cron queries "leads with appointment in next 48h that still
-- need at least one touchpoint." Partial index keeps it small.
CREATE INDEX IF NOT EXISTS leads_appointment_at_idx
  ON leads (appointment_at)
  WHERE appointment_at IS NOT NULL AND reminder_opted_out = FALSE;

-- Index: abandoner cron queries "leads where status != booked and
-- abandoner_step < 5". Partial index on the eligible subset.
CREATE INDEX IF NOT EXISTS leads_abandoner_step_idx
  ON leads (created_at, abandoner_step)
  WHERE abandoner_step < 5 AND reminder_opted_out = FALSE;
