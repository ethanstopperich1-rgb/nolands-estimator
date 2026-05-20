-- 0008_lead_dedup.sql — duplicate-lead linkage + photo reuse.
--
-- When the same homeowner submits an estimate request multiple times
-- (within the dedup window), we INSERT a new row to preserve the
-- audit trail but link it to the original via `parent_lead_id`, copy
-- the painted overlay from the parent so the second submission does
-- NOT cost a Gemini Pro Image call, and SUPPRESS the customer
-- confirmation SMS / Sydney dispatch / rep alert (all already fired
-- on the original).
--
-- Dedup key (enforced in app code, not at the DB level):
--   - normalized phone OR normalized email
--   - within 30 days of the parent's `created_at`
--   - same `office_id` (cross-tenant submissions stay distinct)
--
-- The DB-level concern in THIS migration is just the linkage column +
-- index for fast parent lookup. The dedup logic itself lives in
-- `lib/leads/dedup.ts` so we can iterate on the matching rules
-- without re-running migrations.

begin;

-- The parent linkage. Nullable: most leads are NOT dupes, so this
-- column is null for the canonical first submission and points at
-- the canonical first-submission's `leads.id` for any subsequent dupe.
alter table public.leads
  add column if not exists parent_lead_id uuid references public.leads(id) on delete set null;

-- Comment so the schema documents itself for anyone running
-- \d+ leads in psql.
comment on column public.leads.parent_lead_id is
  'Nullable FK to leads.id. Set when this row is a duplicate submission within the dedup window — points at the canonical first submission. Used to (a) suppress duplicate notifications, (b) reuse the parent''s painted overlay (no extra Gemini cost), (c) group repeat submissions in the dashboard. See lib/leads/dedup.ts for matching rules.';

-- Index for the dashboard query "show me all dupes of this lead."
-- Partial index because most rows have parent_lead_id = null and we
-- don't want to bloat the index with null rows.
create index if not exists leads_parent_lead_id_idx
  on public.leads (parent_lead_id)
  where parent_lead_id is not null;

-- Index supporting the dedup probe in app code:
-- "find recent leads with this phone OR email at this office".
-- We index phone + email separately so either probe is fast; the app
-- code does two OR-d lookups rather than one combined query.
create index if not exists leads_office_phone_recent_idx
  on public.leads (office_id, phone, created_at desc)
  where phone is not null;

create index if not exists leads_office_email_recent_idx
  on public.leads (office_id, email, created_at desc);

commit;
