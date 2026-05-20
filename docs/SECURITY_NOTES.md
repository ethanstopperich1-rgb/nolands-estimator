# Security Notes — 2026-05 Audit Followups

Companion to the audit. This file tracks what was fixed in the
2026-05-18 hardening PR, what's deliberately deferred, and the
operational steps required to fully close each finding.

## Fixed in this PR

| # | Finding | Fix |
| - | --- | --- |
| 1 | `/api/leads/[publicId]/{report,roof-v3}` unauthenticated | `middleware.ts` now gates all `/api/leads/<id>/*` subroutes except `voice-consent` |
| 2 | `voice-consent` replayable → harassment / TCPA exposure | Idempotency: refuse if a `call_recording` consent row already exists for the lead (409) |
| 2 | `voice-consent` payload/header drift breaking dispatch | Now sends `leadId` + `office` (slug) and `x-dispatch-secret` header — matches `/api/dispatch-outbound` contract |
| 3 | `/api/gemini-roof` rate-limited as `standard` | Dropped to `expensive` (10/min) on GET + POST |
| 3 | `?debug=1` leaked Gemini prompt + errors publicly | Gated behind `isStaffRequest()` — non-staff requests have the flag stripped before reaching the handler |
| 3 | `/api/gemini-roof` 500 leaked `err.message` | Generic `{error:"internal"}`; full error stays in Sentry / logs |
| 3 | `/api/gemini-roof` + `/api/places/*` no origin gate | `checkOrigin()` allowlist (env `ALLOWED_ORIGINS` + hard-coded voxaris.io + `*.vercel.app`) |
| 3 | `/api/gemini-roof` + `/api/places/*` no bot gate | `checkBotId()` server-side + `<BotIdClient protect={…}>` on `/` and `/dashboard/estimate` |
| 4 | `lib/ratelimit.ts` fail-open without Redis | Fails CLOSED with 503 in production unless `RATELIMIT_FAIL_OPEN=1` |
| 5 | Staff credentials shared, no audit trail | Rotated to 24-char random (`STAFF_AUTH_PASS=sNLa5bK8n2Lf878qTDvr2y88`); per-user identities deferred — see below |
| 5 | Staff-login brute-forceable | Upstash-backed counter, 5 failures / 15 min lockout per IP |
| 7 | `painted-roofs` bucket public → property-image leak | New 7-day signed URL on upload + `migrations/0017_painted_roofs_private.sql` flips the bucket private |
| 8 | Service-role dashboard fallback bypasses RLS | Opt-in `STRICT_DASHBOARD_AUTH=1` removes the fallback (see "Deferred", below, for why it's opt-in) |
| 12 | `/api/dispatch-outbound` secret compared non-constant-time | `crypto.timingSafeEqual` |
| +  | Second bot signal on lead capture | reCAPTCHA v3 (score ≥ 0.5, action `submit_lead`) layered on top of BotID for `POST /api/leads`. Soft-fails when `RECAPTCHA_SECRET_KEY` is unset so dev keeps working; enforced once configured. Hidden badge + brand-attribution copy on the form per Google's terms. |
| 17 | gemini-roof error disclosure | Generic 500 response (see #3) |

Also restored: `/api/healthz` (audit-adjacent — uptime probe), `/p/:slug` permanent redirect → `/`, `voxaris.io` watermark on painted PNGs.

## Deferred, with rationale

### Per-user staff identities (audit #5)

Migrating off shared `STAFF_AUTH_PASS` to per-user Supabase Auth
identities is the right end-state. Not landed here because:

- 18+ staff users would need invites + first-login flow
- All rep tooling assumes the staff cookie OR a Supabase session — the
  cookie path can't be ripped out until everyone has migrated
- `STRICT_DASHBOARD_AUTH=1` (added here) is the prerequisite — once
  it's flipped on without breaking reps, the cookie path can be
  retired

Plan: send the magic-link invites this week, monitor `auth.users`
growth in Supabase, flip `STRICT_DASHBOARD_AUTH=1` once everyone has
signed in once, then in a follow-up PR drop the cookie path entirely.

### JWT expiry validation in middleware (audit #6)

Middleware checks for cookie PRESENCE, not validity. An expired
Supabase session may slip past middleware until a downstream Server
Component calls `getUser()`. Validating in middleware would add a
network round-trip to every request — the documented trade-off.

No change planned. Server Component fallbacks already catch the
expired-session window within a single request; the gap is bounded.

### Dev fail-open paths (audit #7)

`NODE_ENV !== "production"` paths still allow Basic-Auth-less staff
routes and unbounded rate limits. Kept as-is — preview deploys would
need separate Upstash provisioning otherwise, and the production fail-
closed path (added in this PR for ratelimit) is the actual security
boundary. The behavior is loud in logs.

### Voice consent identity binding (audit #3, fix list #4)

Idempotency closes the harassment-replay path. Binding consent to the
ORIGINAL lead creator (one-time signed token issued at lead-creation,
verified at consent-time) is the cleaner end-state. Not landed because
it requires:

- token issuance baked into `POST /api/leads`
- client-side carrying the token through the share link
- token table + replay defense

Tracked as a follow-up; the idempotency lock is the meaningful
risk reduction in the interim.

### CSP / framing on `/embed` (audit #16)

Intentional — the embed is meant to be iframed on partner roofer
sites. Clickjacking risk is bounded to the embed widget itself, which
does not contain sensitive controls.

### `.env.local.example` drift (audit #19)

Worth cleaning in a non-security PR. Not a direct exploit.

## Required ops steps (not in code)

After deploying this PR, the following must be done in the Supabase /
Vercel consoles to fully close the audit:

1. **Flip `painted-roofs` bucket to private.** Run
   `migrations/0017_painted_roofs_private.sql` against the Supabase
   project (or check the box in Supabase Studio → Storage).
2. **Rotate the staff password.** Set `STAFF_AUTH_PASS` in Vercel to
   the new value (`sNLa5bK8n2Lf878qTDvr2y88`). All current sessions
   invalidate — staff will reauthenticate via `/login`.
3. **Verify `ALLOWED_ORIGINS`.** Defaults cover the voxaris.io hosts;
   only set the env if you're white-labeling for additional roofers.
4. **Provision Upstash Redis in production** if it's not already wired.
   The rate-limiter now returns 503 in prod without it (fail-closed).
   Set `KV_REST_API_URL` + `KV_REST_API_TOKEN`.
5. **(Optional, recommended) Flip `STRICT_DASHBOARD_AUTH=1`** after
   confirming every staff user can sign in via Supabase magic-link.
6. **Configure billing alerts + Sentry rule** per
   `docs/PROD_ALERTS_RUNBOOK.md`.
7. **Provision Google reCAPTCHA v3 keys.** Create a site at
   <https://www.google.com/recaptcha/admin> (v3, domain
   `voxaris.io` + your Vercel preview wildcard if needed). Set
   `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` and `RECAPTCHA_SECRET_KEY` in
   Vercel for Production + Preview. Until both are set, the verifier
   fail-opens and BotID remains the only bot signal on `/api/leads`.
