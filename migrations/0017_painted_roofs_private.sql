-- 0017_painted_roofs_private.sql
--
-- Flip the `painted-roofs` Supabase Storage bucket to private. Anyone
-- who learned a lead's `public_id` (lead_<32-hex>) could previously
-- fetch the property's painted satellite tile via the bucket's public
-- URL. Audit (2026-05) flagged this as PII leakage; the bucket should
-- only be reachable through short-lived signed URLs minted by the
-- service-role client in /api/gemini-roof.
--
-- Idempotent: re-running this on an already-private bucket is a no-op.

update storage.buckets
set public = false
where id = 'painted-roofs';

-- RLS on storage.objects is already enabled by Supabase. No extra
-- policies needed — service-role bypasses RLS to read/write, and
-- anonymous clients are blocked from listing or fetching once the
-- bucket is private. Signed URLs (createSignedUrl) are the only
-- supported read path for non-service-role consumers.
