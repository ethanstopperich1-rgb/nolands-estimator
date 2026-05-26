-- ─────────────────────────────────────────────────────────────────────
-- ops-snapshot.sql — comprehensive "what's happening RIGHT NOW" report
-- ─────────────────────────────────────────────────────────────────────
--
-- Paste any single section into Supabase Studio SQL Editor (project
-- voxaris-roofing-pitch / htfhelquuvndfwfwqjmd) and click Run.
-- Each block is independent — you can grab just the one you need.
--
-- All counts scoped to Noland's office. Change office_id literal at
-- the top if you ever multi-tenant-fork this. The office_id below is
-- looked up by slug at run-time so you never hardcode the UUID.

-- ─────────────────────────────────────────────────────────────────────
-- §1. TOTAL LEADS — lifetime + recent windows
-- ─────────────────────────────────────────────────────────────────────
WITH n AS (SELECT id FROM public.offices WHERE slug = 'nolands' LIMIT 1)
SELECT
  (SELECT COUNT(*) FROM public.leads WHERE office_id = n.id) AS lifetime,
  (SELECT COUNT(*) FROM public.leads WHERE office_id = n.id AND created_at > now() - interval '24 hours') AS last_24h,
  (SELECT COUNT(*) FROM public.leads WHERE office_id = n.id AND created_at > now() - interval '7 days') AS last_7d,
  (SELECT COUNT(*) FROM public.leads WHERE office_id = n.id AND created_at > now() - interval '30 days') AS last_30d
FROM n;

-- ─────────────────────────────────────────────────────────────────────
-- §2. LEAD STATUS BREAKDOWN
-- ─────────────────────────────────────────────────────────────────────
SELECT status, COUNT(*) AS count
FROM public.leads
WHERE office_id = (SELECT id FROM public.offices WHERE slug = 'nolands' LIMIT 1)
GROUP BY status
ORDER BY count DESC;

-- ─────────────────────────────────────────────────────────────────────
-- §3. RECENT LEADS — last 20, full details
-- ─────────────────────────────────────────────────────────────────────
SELECT
  public_id,
  COALESCE(name, '(no name)') AS name,
  COALESCE(phone, '(no phone)') AS phone,
  LEFT(address, 40) AS address_short,
  status,
  estimate_low,
  estimate_high,
  appointment_at,
  callback_dispatched_at IS NOT NULL AS sarah_dialed,
  jobnimbus_contact_id IS NOT NULL AS in_jn,
  parent_lead_id IS NOT NULL AS is_dupe,
  preferred_language AS lang,
  city,
  state,
  to_char(created_at AT TIME ZONE 'America/New_York', 'MM-DD HH24:MI') AS created_et
FROM public.leads
WHERE office_id = (SELECT id FROM public.offices WHERE slug = 'nolands' LIMIT 1)
ORDER BY created_at DESC
LIMIT 20;

-- ─────────────────────────────────────────────────────────────────────
-- §4. TCPA CONSENT INVENTORY (auditable paper trail)
-- ─────────────────────────────────────────────────────────────────────
SELECT
  consent_type,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE consented_at > now() - interval '7 days') AS last_7d,
  COUNT(*) FILTER (WHERE consented_at > now() - interval '24 hours') AS last_24h
FROM public.consents
WHERE office_id = (SELECT id FROM public.offices WHERE slug = 'nolands' LIMIT 1)
GROUP BY consent_type
ORDER BY total DESC;

-- ─────────────────────────────────────────────────────────────────────
-- §5. SARAH CALL EVENTS (last 50, latest first)
-- ─────────────────────────────────────────────────────────────────────
SELECT
  e.type,
  e.at,
  l.public_id AS lead_id,
  l.name AS lead_name,
  LEFT(l.address, 30) AS address,
  e.payload->>'outcome' AS outcome,
  e.payload->>'duration_sec' AS dur,
  to_char(e.at AT TIME ZONE 'America/New_York', 'MM-DD HH24:MI') AS at_et
FROM public.events e
LEFT JOIN public.leads l ON l.id = e.payload->>'lead_id' = l.id::text
                          OR l.public_id = e.payload->>'lead_public_id'
WHERE e.office_id = (SELECT id FROM public.offices WHERE slug = 'nolands' LIMIT 1)
ORDER BY e.at DESC
LIMIT 50;

-- ─────────────────────────────────────────────────────────────────────
-- §6. CALL OUTCOMES (last 30 days)
-- ─────────────────────────────────────────────────────────────────────
SELECT
  COALESCE(outcome, '(in-progress)') AS outcome,
  COUNT(*) AS count,
  ROUND(AVG(EXTRACT(EPOCH FROM (ended_at - started_at))/60)::numeric, 1) AS avg_min
FROM public.calls
WHERE office_id = (SELECT id FROM public.offices WHERE slug = 'nolands' LIMIT 1)
  AND started_at > now() - interval '30 days'
GROUP BY outcome
ORDER BY count DESC;

-- ─────────────────────────────────────────────────────────────────────
-- §7. FUNNEL — last 30 days
-- ─────────────────────────────────────────────────────────────────────
WITH n AS (SELECT id FROM public.offices WHERE slug = 'nolands' LIMIT 1),
  recent AS (SELECT * FROM public.leads WHERE office_id = (SELECT id FROM n) AND created_at > now() - interval '30 days')
SELECT
  (SELECT COUNT(*) FROM recent)                                                              AS leads_total,
  (SELECT COUNT(*) FROM recent WHERE phone IS NOT NULL)                                       AS leads_with_phone,
  (SELECT COUNT(*) FROM recent WHERE estimate_low IS NOT NULL)                                AS leads_with_estimate,
  (SELECT COUNT(DISTINCT c.lead_id) FROM public.consents c WHERE c.office_id = (SELECT id FROM n)
     AND c.consented_at > now() - interval '30 days' AND c.consent_type = 'call_recording')   AS voice_consent_given,
  (SELECT COUNT(*) FROM recent WHERE callback_dispatched_at IS NOT NULL)                      AS sarah_dispatched,
  (SELECT COUNT(*) FROM recent WHERE appointment_at IS NOT NULL)                              AS appt_booked,
  (SELECT COUNT(*) FROM recent WHERE status = 'won')                                          AS won,
  (SELECT COUNT(*) FROM recent WHERE jobnimbus_contact_id IS NOT NULL)                        AS in_jn;

-- ─────────────────────────────────────────────────────────────────────
-- §8. DAILY ACTIVITY — leads + calls per day, last 14 days
-- ─────────────────────────────────────────────────────────────────────
WITH n AS (SELECT id FROM public.offices WHERE slug = 'nolands' LIMIT 1),
  d AS (SELECT generate_series(now()::date - interval '13 days', now()::date, '1 day'::interval)::date AS day)
SELECT
  d.day,
  (SELECT COUNT(*) FROM public.leads WHERE office_id = (SELECT id FROM n) AND created_at::date = d.day) AS new_leads,
  (SELECT COUNT(*) FROM public.calls WHERE office_id = (SELECT id FROM n) AND started_at::date = d.day) AS calls,
  (SELECT COUNT(*) FROM public.calls WHERE office_id = (SELECT id FROM n) AND started_at::date = d.day AND outcome = 'appt_scheduled') AS booked
FROM d
ORDER BY d.day DESC;

-- ─────────────────────────────────────────────────────────────────────
-- §9. GEMINI COST COUNTER (paint-pipeline spend, today)
-- ─────────────────────────────────────────────────────────────────────
SELECT * FROM public.gemini_cost_counter
WHERE day = now()::date
ORDER BY office_id;

-- ─────────────────────────────────────────────────────────────────────
-- §10. ZIP DISTRIBUTION (where are leads coming from?)
-- ─────────────────────────────────────────────────────────────────────
SELECT
  zip,
  city,
  state,
  COUNT(*) AS leads,
  AVG(COALESCE(estimate_low,0))::int AS avg_low,
  AVG(COALESCE(estimate_high,0))::int AS avg_high
FROM public.leads
WHERE office_id = (SELECT id FROM public.offices WHERE slug = 'nolands' LIMIT 1)
  AND zip IS NOT NULL
  AND created_at > now() - interval '30 days'
GROUP BY zip, city, state
ORDER BY leads DESC
LIMIT 15;

-- ─────────────────────────────────────────────────────────────────────
-- §11. DEDUP HEALTH (how many recent submits are dupes?)
-- ─────────────────────────────────────────────────────────────────────
SELECT
  COUNT(*) FILTER (WHERE parent_lead_id IS NULL) AS fresh,
  COUNT(*) FILTER (WHERE parent_lead_id IS NOT NULL) AS duplicates,
  ROUND(100.0 * COUNT(*) FILTER (WHERE parent_lead_id IS NOT NULL) / NULLIF(COUNT(*), 0), 1) AS dupe_pct
FROM public.leads
WHERE office_id = (SELECT id FROM public.offices WHERE slug = 'nolands' LIMIT 1)
  AND created_at > now() - interval '30 days';
