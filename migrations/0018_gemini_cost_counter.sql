-- 0018_gemini_cost_counter.sql
--
-- Per-office daily Gemini Pro Image call counter with a configurable
-- daily cap. Bounds tail-risk on the $0.134/call image-edit pricing
-- and serves as the drift-detection signal source per the Wave 1 plan
-- (research finding A3).
--
-- Schema:
--   gemini_calls — one row per call, append-only audit trail
--   offices.daily_image_cap — per-office override (default 25)
--
-- Usage from /api/gemini-roof:
--   1. SELECT count(*) FROM gemini_calls
--        WHERE office_id = $1 AND day = current_date;
--   2. If >= office.daily_image_cap → 429 with retry-after.
--   3. After successful call: INSERT INTO gemini_calls.
--
-- Drift detection (nightly cron):
--   SELECT office_id, avg(tokens_out) FILTER (WHERE day > now() - 7d) /
--          avg(tokens_out) FILTER (WHERE day > now() - 30d) AS ratio
--   FROM gemini_calls GROUP BY 1
--   HAVING ratio > 1.25;  -- alert on >25% growth

-- ─── Add the daily cap column to offices ──────────────────────────────
-- Default 25 calls/day per the Wave 1 cost-cap decision (conservative,
-- can bump via UPDATE offices SET daily_image_cap = 50 WHERE slug = ...)
ALTER TABLE offices
  ADD COLUMN IF NOT EXISTS daily_image_cap INTEGER NOT NULL DEFAULT 25;

COMMENT ON COLUMN offices.daily_image_cap IS
  'Max Gemini Pro Image calls per day for this office. Set to a higher value once ROI is proven; the conservative default protects against retry-loop runaways. NULL not allowed — every office must have a cap.';

-- ─── Per-call audit trail ─────────────────────────────────────────────
-- One row per Gemini Pro Image OR Flash call. Used for cost accounting,
-- drift detection, and forensic replay after a quality regression.
CREATE TABLE IF NOT EXISTS gemini_calls (
  id            BIGSERIAL PRIMARY KEY,
  office_id     UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  -- Day partition for efficient daily counts. Derived from created_at
  -- but stored explicitly so the index is fast (composite (office_id, day)).
  day           DATE NOT NULL DEFAULT current_date,
  -- "pro_image" for the painted-roof call, "flash" for the sidecar
  -- object-detection call, "flash_text" for the rich-data call.
  model_kind    TEXT NOT NULL CHECK (model_kind IN ('pro_image', 'flash', 'flash_text')),
  -- Cost in cents (integer, avoids floating-point drift on rollups).
  -- Pro Image = ~13 cents/call at 1K res; Flash ~0.05 cents/call.
  cost_cents    INTEGER NOT NULL DEFAULT 0,
  -- Output token count for drift detection. A jump in avg tokens-out
  -- is the canary for "model started returning verbose output" or
  -- "prompt regression caused retries."
  tokens_out    INTEGER,
  -- Lead this call was for. NULL if call happened outside the
  -- normal /api/gemini-roof flow (e.g. eval suite).
  lead_id       UUID,
  -- Address being painted, useful for forensic replay. Not unique —
  -- one address can be repainted on retry.
  address       TEXT,
  -- Optional response-quality score from the eval gates (A7). NULL
  -- until those gates ship.
  quality_score NUMERIC(4, 3),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE gemini_calls IS
  'Append-only audit trail for every Gemini API call. Source of truth for cost accounting + drift detection. Never UPDATEd or DELETEd in normal operation; older rows aged out via partition rotation if volume requires.';

-- Hot path index: per-office, per-day counts.
CREATE INDEX IF NOT EXISTS gemini_calls_office_day_idx
  ON gemini_calls (office_id, day);

-- Forensic-replay index: find all calls for a given lead.
CREATE INDEX IF NOT EXISTS gemini_calls_lead_idx
  ON gemini_calls (lead_id) WHERE lead_id IS NOT NULL;

-- Drift-detection index: time-windowed scans.
CREATE INDEX IF NOT EXISTS gemini_calls_created_at_idx
  ON gemini_calls (created_at DESC);

-- ─── RLS: same office_id model as the rest of the system ──────────────
-- Reps in office A must not see office B's cost data.
ALTER TABLE gemini_calls ENABLE ROW LEVEL SECURITY;

-- Authenticated reps see only their own office's call history.
CREATE POLICY gemini_calls_select_own_office
  ON gemini_calls
  FOR SELECT
  TO authenticated
  USING (office_id = public.current_office_id() OR public.is_admin());

-- Service role bypasses RLS (used by /api/gemini-roof to insert).
-- Inserts from anon are rejected — only the API route writes here.
CREATE POLICY gemini_calls_no_anon_insert
  ON gemini_calls
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

CREATE POLICY gemini_calls_no_update
  ON gemini_calls
  FOR UPDATE
  TO authenticated
  USING (false);

CREATE POLICY gemini_calls_no_delete
  ON gemini_calls
  FOR DELETE
  TO authenticated
  USING (false);

-- ─── Helper: daily count for an office ────────────────────────────────
-- Wrapped as a SQL function so the API route can call it via RPC
-- without hand-writing the predicate every time. STABLE because the
-- result is fully determined by inputs + current_date (no side effects).
CREATE OR REPLACE FUNCTION public.gemini_calls_today(p_office_id UUID)
  RETURNS INTEGER
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT count(*)::INTEGER
  FROM gemini_calls
  WHERE office_id = p_office_id
    AND day = current_date;
$$;

COMMENT ON FUNCTION public.gemini_calls_today(UUID) IS
  'Count of Gemini calls made today for this office. Used by /api/gemini-roof to gate against offices.daily_image_cap.';
