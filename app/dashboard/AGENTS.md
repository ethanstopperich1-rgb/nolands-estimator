# `app/dashboard/` — rep-facing surface

The internal sales tooling. Everything under `/dashboard/*` is
staff-gated by `middleware.ts` (HTTP Basic + Supabase Auth). Customer
flows live elsewhere (`app/page.tsx`).

## Layout

- `layout.tsx` — chrome (sidebar via `DashboardChrome`, header, demo
  banner). Wraps every dashboard route.
- `page.tsx` — overview dashboard (KPI cards, recent leads).
- `leads/` — lead list (`page.tsx`) + per-lead full report
  (`[publicId]/page.tsx`).
- `estimate/` — full V3 workbench (`page.tsx?leadId=…`). The rep
  version of the customer flow.
- `canvass/` — door-to-door storm canvass map (CanvassMap).
- `calls/` — outbound call list + dispositions.
- `analytics/` — funnel + cohort reports.
- `admin/` — office settings, user management.

## Auth model

Two layers:

1. **HTTP Basic** at the middleware (`STAFF_AUTH_USER` /
   `STAFF_AUTH_PASS` env). Coarse gate — gets you into the dashboard.
2. **Supabase Auth** (magic-link) — rep identity. Resolved via
   `getDashboardUser` → reads `public.users` for the JWT `auth.uid()`
   → returns `{ id, email, full_name, office_id, role }`.

`office_id` is the tenancy key. Every Supabase query in the dashboard
filters by office_id (either via `.eq("office_id", officeId)` or via
RLS policies that read `current_office_id()`). RLS isn't fully wired
yet; the explicit filter is the belt + suspenders approach.

`STRICT_DASHBOARD_AUTH=1` makes `getDashboardOfficeId()` return null
when there's no Supabase session (instead of falling back to the seed
office). Enable this once magic-link is stable for all offices.

## Demo mode

When the demo cookie `voxaris_demo_office` is set to a known slug
(`voxaris` / `nolands` / etc.), the dashboard renders demo data
instead of real Supabase rows. Switcher routes:

- `/api/office/switch` — sets the cookie (public, but only allows
  whitelisted slugs)
- `/api/demo/role` — toggles rep/manager view (public, demo-only)

**Demo cookie ≠ real session.** The cookie controls which set of
seed data the dashboard renders. A real authenticated rep with a
different office_id sees their REAL data regardless of the cookie.
Don't conflate the two; bugs from this confusion were the reason for
`getDashboardOfficeId`'s defensive structure.

## Conventions

### Server components by default

The dashboard is server-rendered. Add `"use client"` only when you
need interactivity (a button, a table sort, a drawer). The lead list
(`leads/page.tsx`) is server-rendered with the rows pulled inline.
Interactive bits are extracted into `components/dashboard/*.tsx`.

### Server actions for mutations

Use server actions (`"use server"` files like
`app/dashboard/leads/actions.ts:updateLeadStatus`) for mutations from
the dashboard UI. They run with the cookie-adapter Supabase client
(RLS-respecting + JWT-aware) and SHOULD filter by office_id in the
WHERE clause as a belt + suspenders check.

### Revalidate after mutations

After any write, call `revalidatePath("/dashboard/leads")` and
`revalidatePath("/dashboard")` so the next render sees the new state.
Cached server data is the default; without revalidate you ship stale
UI to the user who just edited.

### The drawer pattern was replaced

`/dashboard/leads` used to use a drawer overlay for lead detail; in
`770880f` Brad refactored to full-page navigation at
`/dashboard/leads/[publicId]`. The drawer code in `LeadsTable.tsx`
is dead and slated for removal. If you're tempted to bring back the
drawer, talk to Brad first — there was a reason.

## Lead report page

`/dashboard/leads/[publicId]` renders the full V3 report from
`leads.roof_v3_json`. It does NOT re-run the pipeline; everything
comes from the persisted JSON. Re-run is a one-click action that
hits `POST /api/leads/[publicId]/roof-v3` (office-id checked, see
that route's docs).

## Smoke-test before shipping

The dashboard has no automated test coverage. Before shipping any
dashboard change, manually verify:

- Lead list renders with the demo office_id (no Supabase session)
- Lead list renders with a real session (different office sees
  different rows)
- A status mutation updates the cell + persists across refresh
- The drawer / full-report page renders without console errors for
  a lead with and without `roof_v3_json`
