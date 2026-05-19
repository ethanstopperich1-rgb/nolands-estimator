# `app/api/leads/*` — lead capture + sub-routes

The seam between the customer flow (BotID-guarded) and the rep flow
(staff-gated). The `[publicId]` segment is a 32-hex random ID
generated server-side; treat it as the canonical opaque handle.

## Routes

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/leads` | POST | BotID + rate-limit | Capture lead from customer flow. Returns `{ publicId }`. |
| `/api/leads/[publicId]` | GET | Staff | Read full lead row. Office-id check enforced. |
| `/api/leads/[publicId]/voice-consent` | POST | Public (customer) | Capture TCPA voice consent after estimate. |
| `/api/leads/[publicId]/roof-v3` | POST | Staff + office-id match | Re-run V3 pipeline for a lead. |

## Public vs staff sub-routes

The middleware (`middleware.ts` + `lib/protected-routes.ts`) is
default-deny on `/api/leads/[publicId]/<sub>`. The only sub-route
that's customer-callable is `voice-consent`, listed in
`PUBLIC_LEAD_SUBROUTES`. Everything else is staff-gated.

**To add a new customer-callable sub-route:** add it to
`PUBLIC_LEAD_SUBROUTES` in `lib/protected-routes.ts`. The middleware
will read the new value automatically; no other code changes needed.

**To add a new staff sub-route:** just create the file. It's
automatically staff-gated. BUT — and this is the easy-to-miss part —
middleware only checks "is the caller authenticated as staff?", not
"do they belong to this lead's office?" You must add the office_id
match yourself. See `roof-v3/route.ts` for the canonical pattern:

```ts
const callerOfficeId = await getDashboardOfficeId();
if (!callerOfficeId) return NextResponse.json({error:"unauthorized"}, {status:401});

const { data: lead } = await supabase.from("leads")
  .select("id, office_id, …")
  .eq("public_id", publicId)
  .maybeSingle();
if (!lead) return NextResponse.json({error:"lead_not_found"}, {status:404});

// Same 404 surface so cross-tenant probe can't distinguish
// "doesn't exist" from "exists but isn't mine"
if (lead.office_id !== callerOfficeId) {
  console.warn("[…] cross_office_block", …);
  return NextResponse.json({error:"lead_not_found"}, {status:404});
}
```

## `/api/leads` POST — the big one

Capture from the customer flow. Handles:

1. BotID verification (`botid/server` — gates all customer routes
   declared in `app/page.tsx:BotIdClient`).
2. Rate limit via `lib/ratelimit.ts`.
3. reCAPTCHA v3 token check (`lib/useRecaptcha.ts` on client side).
4. Lead-shape validation (`lib/leads/validation.ts`, unit-tested in
   `tests/leads-validation.test.ts`).
5. Geocoding (the customer already resolved address → lat/lng via
   Places autocomplete; this is a sanity check).
6. Supabase insert (service role) with `office_id` resolved from
   `geographicallyMatchedOffice` or the fallback office.
7. **Voice-consent gate** — if `voiceConsent === true` AND we have a
   phone + INTERNAL_DISPATCH_SECRET + estimate, fire-and-forget call
   to `/api/dispatch-outbound` (Twilio + Retell). **Strict `=== true`
   check; omission does NOT count as consent** (TCPA compliance —
   see commit `ba70b84`).
8. Optional `estimate` block snapshot (the customer's final V3
   numbers) saved alongside the lead for the rep's record.

The route is large (~700 lines). The structure roughly:

| Lines | What |
|---|---|
| 1-100 | Imports, types, helpers |
| ~100-200 | Input parsing + validation |
| ~200-400 | Insert / upsert logic, office assignment |
| ~400-600 | Estimate snapshot persistence + roof_v3_json hand-off |
| ~600-720 | Voice dispatch gate |

## TCPA + consent

Two separate consents in the customer flow:

- **Marketing consent** — text / email follow-up. Captured on the
  hero form. Required to submit.
- **Voice consent** — autodialed call. Captured AFTER the customer
  sees their estimate, via the `voice-consent` sub-route. Required
  before any outbound dispatch fires.

Both consents persist to the `consents` table with disclosure text +
IP + UA + timestamp. Disclosure text is server-side
(`lib/tcpa-consent.ts`) — never accept it from the client (a
malicious client could forge the audit trail).

`lib/tcpa-consent.ts` unit tests at `tests/tcpa-consent.test.ts`.

## Common edits

| Change | Where |
|---|---|
| Add a new field to the customer form | Update validation in `lib/leads/validation.ts` AND the schema in `app/api/leads/route.ts` parse step AND the BotIdClient protect list in `app/page.tsx` if it's a new endpoint |
| Add a new customer-callable sub-route | Add the segment to `PUBLIC_LEAD_SUBROUTES` |
| Add a new staff sub-route | Add the office_id match (see pattern above) |
| Change consent text | Edit `lib/tcpa-consent.ts:buildMarketingConsentText` / `buildVoiceConsentDisclosureText`. Run the unit tests. |
| Change voice dispatch trigger condition | The strict `voiceConsent === true` check at the bottom of `route.ts`. Don't reintroduce omission-allowed paths. |

## Gotchas

- **Service-role writes bypass RLS** — always filter by office_id in
  the WHERE clause as belt + suspenders.
- **`public_id` regex is canonical: `/^lead_[0-9a-f]{32}$/i`.** Any
  looser regex weakens the entropy floor.
- **`waitUntil` for fire-and-forget** — `@vercel/functions` exposes
  `waitUntil` to keep async work running after the response returns.
  Used for dispatch + persistence. Customer response shouldn't block
  on Twilio / Retell / Supabase upload.
