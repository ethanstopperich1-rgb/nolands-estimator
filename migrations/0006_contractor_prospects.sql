-- =====================================================================
-- 0006_contractor_prospects.sql
--
-- B2B outbound prospect store for FL roofing contractors (Instantly).
-- Populated by scripts/contractor-intel/run_pipeline.py via service role.
-- After apply: regenerate types/supabase.ts via Supabase MCP generate_typescript_types.
-- Separate from `leads` (homeowner) and `canvass_targets` (storm addresses).
-- =====================================================================

create table if not exists public.contractor_prospects (
  license_number        text primary key,

  -- DBPR seed
  board_number          text,
  occupation_code       text,
  licensee_name         text,
  dba_name              text,
  class_code            text,
  address_line1         text,
  address_line2         text,
  address_line3         text,
  city                  text,
  state                 text,
  zip                   text,
  county_code           text,
  county_name           text,
  license_status        text,
  secondary_status      text,
  original_license_date date,
  expiration_date       date,

  -- Discovery / enrichment
  website               text,
  domain                text,
  contact_first_name    text,
  contact_last_name     text,
  contact_title         text,
  email                 text,
  email_confidence      text check (email_confidence in ('high', 'medium', 'low')),
  phone                 text,

  -- Scoring
  lead_score            numeric(5, 2) not null default 0,
  signals               jsonb not null default '{}'::jsonb,

  -- Pipeline state
  enrichment_status     text not null default 'discovered'
    check (enrichment_status in (
      'discovered', 'web_found', 'enriched', 'export_ready', 'excluded'
    )),
  exclude_reason        text,
  last_scraped_at       timestamptz,
  instantly_exported_at timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists contractor_prospects_score_idx
  on public.contractor_prospects (lead_score desc);

create index if not exists contractor_prospects_status_idx
  on public.contractor_prospects (enrichment_status);

create index if not exists contractor_prospects_domain_idx
  on public.contractor_prospects (lower(domain))
  where domain is not null;

-- Service-role scripts only — no authenticated RLS policies in v1.
alter table public.contractor_prospects enable row level security;

drop policy if exists contractor_prospects_service_all on public.contractor_prospects;
create policy contractor_prospects_service_all on public.contractor_prospects
  for all to service_role
  using (true)
  with check (true);
