# White-label deployment guide

Voxaris Pitch supports two complementary models. Pick **one per partner** — mixing them without documenting which layer owns branding causes wrong company names on PDFs, SMS, and TCPA receipts.

## Model A — One Vercel project, many offices (recommended at scale)

- Single deployment (e.g. `pitch.voxaris.io`).
- Each roofing company is a row in Supabase `offices` (`slug`, `name`, `brand_color`, `twilio_number`, `livekit_agent_name`).
- Customer surfaces pass `?office=<slug>` or embed `data-brand="<slug>"` on the widget.
- `POST /api/leads` requires a valid active slug; consent text names that office.
- Staff use Supabase Auth + RLS (`office_id` isolation).

**Setup:** run migrations, insert an `offices` row, map staff users to that `office_id`, set Twilio/LiveKit per office in the dashboard settings page.

## Model B — One Vercel project per partner (isolated deploy)

- Fork or branch deploy with env-only branding (no shared Supabase tenant).
- Set canonical env vars (see below). Optional `PITCH_*` overrides in `lib/branding.ts` for PDF colors and default pricing.
- Use when a partner requires separate infrastructure, billing, or data residency.

## Environment variables (canonical)

| Variable | Purpose |
| --- | --- |
| `PITCH_COMPANY_NAME` | PDF + fallback display name |
| `PITCH_PHONE` | Customer-facing phone |
| `PITCH_EMAIL` | Customer-facing email |
| `PITCH_WEBSITE` | Website URL on proposals |
| `PITCH_PRIMARY_COLOR` | PDF header hex |
| `PITCH_ACCENT_COLOR` | UI accent hex |
| `PITCH_SHOW_XACTIMATE` | `true` for insurance line items |

`ROOFAI_*` names are **deprecated aliases** for the same keys (repo legacy name).

## Embed snippet

```html
<div data-voxaris-pitch data-brand="acme-roofing" data-accent="e85d04"></div>
<script src="https://pitch.voxaris.io/embed.js" async></script>
```

Leads are tagged `source: embed-{brand}` and `office` resolves from `data-brand`.

## Customer proposal links

Public share URLs at `/p/<id>` were **retired** (redirect to `/`). Share estimates via the rep dashboard export (PDF/email) or your CRM webhook (`LEAD_WEBHOOK_URL`).

## Compliance

- Marketing SMS/email: checkbox + server-stored disclosure from `lib/tcpa-consent.ts` (office-specific).
- Outbound AI voice: separate opt-in on the result step → `POST /api/leads/<id>/voice-consent`.
- Do not enable `INTERNAL_DISPATCH_SECRET` voice dispatch without A2P 10DLC / toll-free verification on Twilio.

