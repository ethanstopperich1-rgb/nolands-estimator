-- 0019_lead_jobnimbus_contact.sql
--
-- Add jobnimbus_contact_id to the leads table so we can track which
-- JobNimbus contact corresponds to which lead in our system. Prevents
-- duplicate contacts in JobNimbus when:
--   1. Customer submits the estimator form → push to JobNimbus,
--      stash contact_id on the lead row.
--   2. Sydney later dispatches an outbound call for that same lead →
--      reads contact_id from the lead row → updates the existing
--      JobNimbus contact instead of creating a fresh one.
--
-- Without this column, Sydney's book_inspection always creates a new
-- contact (matching on display_name only), which leaves Noland's
-- reps with two records: "Sarah Smith" from the estimator + "Sarah
-- Smith" from Sydney's call. Fragmented history.
--
-- Column type: text. JobNimbus contact identifiers are strings (their
-- API returns "jnid" — JobNimbus internal ID, opaque, not a UUID).
-- Nullable: yes. Soft-fail path when JOBNIMBUS_API_KEY is unset
-- leaves the column NULL; Sydney's existing MOCK fallback still fires.
--
-- Index: yes. Sydney's dispatch lookup is a single-row read by
-- public_id, but having an index lets ops query "show all leads
-- without a JobNimbus contact" for backfill work without a full scan.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS jobnimbus_contact_id TEXT;

COMMENT ON COLUMN leads.jobnimbus_contact_id IS
  'JobNimbus contact identifier (jnid). NULL until the JobNimbus push fires successfully. Used by /api/dispatch-outbound to thread the existing contact into Sydney metadata so book_inspection updates rather than duplicating.';

-- Partial index — only leads that have a JobNimbus contact are
-- interesting for "find by JN contact" queries. WHERE clause keeps
-- the index small.
CREATE INDEX IF NOT EXISTS leads_jobnimbus_contact_idx
  ON leads (jobnimbus_contact_id)
  WHERE jobnimbus_contact_id IS NOT NULL;
