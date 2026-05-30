-- =====================================================================
-- 0025_sms_messages.sql
--
-- SMS message tracking / audit log.
--
-- Until now, every outbound SMS (estimate-ready confirmation, T+2h
-- touchpoint, scheduling slot offers, rep alerts) and every inbound
-- reply (YES / SCHEDULE / STOP) lived only in Twilio's dashboard +
-- whatever ad-hoc console logging the route happened to emit. There
-- was no first-class, queryable record of "what did we text this
-- homeowner, when, and did it deliver?" — which the dashboard needs
-- for the per-lead conversation timeline and which we need for TCPA
-- forensics (proving what was sent, with what body, to which number).
--
-- This table is the durable mirror of Twilio's message lifecycle.
-- Writes happen exclusively through the service role:
--   * /api/sms/* send paths insert the outbound row (message_sid from
--     the Twilio create-message response).
--   * the Twilio status-callback webhook UPSERTs status / error_code
--     by message_sid as the message moves queued → sent → delivered /
--     failed / undelivered.
--   * /api/sms/inbound inserts the inbound row (direction='inbound').
-- None of those have an authenticated user session, so — exactly like
-- 0004_sms_opt_outs — there are no INSERT / UPDATE policies for
-- authenticated callers; the service-role key bypasses RLS entirely
-- (Supabase default) and is the only writer. Authenticated dashboard
-- staff get an office-scoped SELECT. There is no anon policy, so anon
-- access is denied by default.
--
-- message_sid is UNIQUE so the status-callback webhook can UPSERT on
-- it without creating duplicate rows when Twilio retries a callback.
-- It is nullable only transiently — the send path inserts the row
-- after Twilio returns the SID, so in practice it is always set on
-- outbound rows; inbound rows always carry the MessageSid from the
-- webhook payload.
--
-- Additive only — no destructive changes, no rewrites, safe to apply
-- in any order vs the surrounding migrations.
--
-- Apply via psql (session-pooler URL) or paste into the Supabase
-- Studio SQL Editor:
--   psql "<session-pooler-url>" -f migrations/0025_sms_messages.sql
-- =====================================================================

create table if not exists public.sms_messages (
  id              uuid primary key default gen_random_uuid(),

  -- Twilio Message SID (SMxxxxxxxx...). Natural dedup key — the
  -- status-callback webhook UPSERTs on this as the message lifecycle
  -- advances. Unique so a retried callback can't fork into two rows.
  message_sid     text unique,

  -- Endpoints, E.164. to_e164 = the homeowner (outbound) or the
  -- sender (inbound); from_e164 = our Twilio number (outbound) or the
  -- homeowner (inbound).
  to_e164         text,
  from_e164       text,

  -- Message body as sent / received. Retained for the dashboard
  -- conversation timeline + TCPA forensics.
  body            text,

  -- 'outbound' = we sent it; 'inbound' = the homeowner replied.
  direction       text check (direction in ('inbound', 'outbound')),

  -- Twilio message status (queued / sending / sent / delivered /
  -- undelivered / failed / received). Free text — Twilio's status
  -- vocabulary evolves and we don't want a CHECK that a new status
  -- value would reject.
  status          text,

  -- Twilio error code when status is failed / undelivered (e.g.
  -- 30007 carrier filtering, 21610 STOP). Null on success.
  error_code      text,

  -- Tenant scoping. References offices for the per-office dashboard
  -- read; nullable + set null on delete so a message row outlives an
  -- office teardown (audit trail must persist).
  office_id       uuid references public.offices (id) on delete set null,

  -- The lead this message belongs to, by public_id (the same handle
  -- the /r/[publicId] share page + dispatch payload use). Text, not a
  -- FK — messages can predate / outlive the lead row and we don't want
  -- a delete to cascade away the SMS audit trail.
  lead_public_id  text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ─── Indexes ──────────────────────────────────────────────────────────
-- message_sid uniqueness is enforced by the column-level UNIQUE above
-- (which creates its own index); no separate index needed for it.

-- Look up all messages to / from a given number (conversation thread,
-- opt-out cross-check).
create index if not exists sms_messages_to_idx
  on public.sms_messages (to_e164);

-- Recent-first feed for the dashboard timeline.
create index if not exists sms_messages_created_idx
  on public.sms_messages (created_at desc);

-- ─── updated_at trigger ───────────────────────────────────────────────
-- Reuse the shared touch_updated_at() from 0001_initial_schema.sql so
-- the status-callback UPSERT bumps updated_at automatically.
drop trigger if exists sms_messages_touch_updated_at on public.sms_messages;
create trigger sms_messages_touch_updated_at
  before update on public.sms_messages
  for each row execute function public.touch_updated_at();

-- ─── RLS ──────────────────────────────────────────────────────────────
alter table public.sms_messages enable row level security;

-- Staff in the office read messages for that office. Admins read all.
-- WRITES go only through the service role (the SMS send paths +
-- Twilio status-callback / inbound webhooks have no user session), so
-- there are no INSERT / UPDATE policies for authenticated users — the
-- service-role key bypasses RLS entirely. No anon policy is declared,
-- so anonymous access is denied by default.
drop policy if exists sms_messages_select_office on public.sms_messages;
create policy sms_messages_select_office on public.sms_messages
  for select to authenticated
  using (office_id = public.current_office_id() or public.is_admin());

-- Belt-and-suspenders: explicitly forbid UPDATE / DELETE by any
-- non-service-role caller. The message audit trail must be immutable
-- to dashboard staff — corrections happen via the service role on the
-- webhook path, never by hand.
drop policy if exists sms_messages_no_update on public.sms_messages;
create policy sms_messages_no_update on public.sms_messages
  for update to authenticated using (false);

drop policy if exists sms_messages_no_delete on public.sms_messages;
create policy sms_messages_no_delete on public.sms_messages
  for delete to authenticated using (false);

-- ─── Comments ─────────────────────────────────────────────────────────
comment on table public.sms_messages is
  'Durable mirror of Twilio SMS lifecycle (outbound + inbound). Service-role write-only via SMS send paths + status-callback / inbound webhooks; office-scoped authenticated SELECT for the dashboard timeline. message_sid UNIQUE for webhook UPSERT dedup.';
comment on column public.sms_messages.message_sid is
  'Twilio Message SID. UNIQUE — the status-callback webhook UPSERTs on this as the message advances queued → delivered / failed.';
comment on column public.sms_messages.direction is
  'outbound = we sent it; inbound = homeowner reply (YES / SCHEDULE / STOP).';
comment on column public.sms_messages.error_code is
  'Twilio error code on a failed / undelivered message (e.g. 30007, 21610). Null on success.';
comment on column public.sms_messages.lead_public_id is
  'lead.public_id this message belongs to. Text, not a FK — the SMS audit trail must outlive the lead row.';
