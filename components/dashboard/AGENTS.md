# `components/dashboard/` — rep-facing React components

Client-side components consumed by the staff-gated `/dashboard/*`
routes. Server-rendering happens at the page level; these add
interactivity (sort, drawer, table row clicks, map controls).

## Components

| File | Used by | What |
|---|---|---|
| `DashboardChrome.tsx` | `app/dashboard/layout.tsx` | Sidebar nav + demo banner + office switcher chrome |
| `LeadsTable.tsx` | `app/dashboard/leads/page.tsx` | Sortable lead table. **1,337 lines.** Slated for split — see below. |
| `LeadReport.tsx` | `app/dashboard/leads/[publicId]/page.tsx` | Full-page V3 report reader |
| `CanvassMap.tsx` | `app/dashboard/canvass/page.tsx` | Google Map + lead pins + storm heatmap |
| `CanvassView.tsx` | `app/dashboard/canvass/page.tsx` | Side panel for canvass map (lead detail, filters) |
| `CallsTable.tsx` | `app/dashboard/calls/page.tsx` | Outbound call list + disposition filter |
| `DemoBanner.tsx` | `DashboardChrome` | "You are in demo mode" warning strip |

## Conventions

### `"use client"` at the top of every file here

These are all interactive. Don't try to make them server components
without confirming none of their hooks (useState, useEffect, click
handlers) get used.

### Read from `roof_v3_json`, never re-fetch

`LeadReport` is the rendering layer for the V3 response shape. It
reads from the persisted JSON column on the lead row. **Never call
`/api/gemini-roof` from a component to re-fetch a stale lead.** If
the data is missing or stale, the rep clicks "Regenerate" which
hits `POST /api/leads/[publicId]/roof-v3` server-side.

### Office-id scoping is upstream

Components don't filter by office_id; the route / server action that
fed them already did. The trust boundary is the page-level data
fetch, not the component.

### Table dedupe rules

`LeadsTable` does client-side dedup on `public_id`. Don't add
server-side rendering of the same lead under two rows expecting the
client to merge — the client logic only handles exact id duplicates,
not "same address different lead." If you need cross-lead aggregation,
do it in the server query.

## `LeadsTable.tsx` is too big

1,337 lines. Combines: table render, drawer (now dead since lead
detail moved to a full page in `770880f`), regenerate-painted CTA,
status mutator wiring, filter chips. Brad has flagged it for split:

- `LeadsTable.tsx` — table-only
- `LeadDrawer.tsx` — drawer (if we keep it) OR delete entirely
- `LeadRegenerateButton.tsx` — regenerate CTA extracted

Don't add new behavior to the existing file without splitting first.
The audit caught this as item #21 (debt that's already bit us twice
when fixes shipped to one side and not the other).

## Smoke-test before shipping component changes

The dashboard has no E2E. Manually verify:

- `LeadsTable` renders with mixed-status leads (open / contacted /
  booked / lost)
- Status mutation updates the cell + persists across refresh (the
  server action revalidates the path)
- `LeadReport` renders without console errors for a lead with and
  without `roof_v3_json` (the optional fields gracefully degrade)
- `CanvassMap` loads tiles + draws pins without dependency on a real
  storm event (storm-less geographies should still render)

## Where the brand styles live

- `.voxaris` scoped styles in `app/globals.css` (customer-side only)
- Dashboard uses the global dark theme (`html.dark`), not the cream
  customer palette. Don't import `.voxaris` styles here.
- Brand colors via CSS custom properties on the body. New colors go
  in `@theme inline {…}` in `app/globals.css`.
