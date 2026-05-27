# SpyFu API — credential setup

The `lib/spyfu.ts` client + `/api/internal/spyfu-sync` route are wired
and waiting on two env vars. Set them yourself — never paste API keys
in chat or commit them to the repo.

## What to provision

| Env var | Where to get it | Notes |
|---|---|---|
| `SPYFU_API_ID` | spyfu.com → your account → API page → "API ID" | 6-12 char identifier, not secret |
| `SPYFU_API_KEY` | spyfu.com → your account → API page → "API Key" | 32-char secret, **never paste in chat** |
| `SPYFU_DEFAULT_DOMAIN` | optional — defaults to `nolandsroofing.com` | override for competitor pulls |

## Pricing context (so you pick the right plan)

SpyFu's API access tiers (May 2026):
- **Basic ($39/mo):** No API access. Skip.
- **Professional ($79/mo):** 10,000 API calls/mo. Enough for weekly
  full-corpus refreshes on 5 domains.
- **Team ($149/mo):** 100,000 API calls/mo. Enough for daily refreshes
  + ad-hoc competitor sweeps.

Voxaris-scale recommendation: **Professional is plenty** for a single
client like Noland's. Upgrade to Team only when running 5+ Florida
roofers in parallel.

## Two ways to set the env vars

### Option A — Vercel prod (recommended)

```bash
cd /Users/voxaris/nolands-estimator

vercel env add SPYFU_API_ID production
# paste your API ID when prompted (not the key)

vercel env add SPYFU_API_KEY production
# paste your API key when prompted

# optional override
vercel env add SPYFU_DEFAULT_DOMAIN production
# value: nolandsroofing.com
```

After setting, redeploy: `vercel deploy --prod --force`.

### Option B — Local dev (.env.local)

```bash
echo "SPYFU_API_ID=your_id_here" >> .env.local
echo "SPYFU_API_KEY=your_key_here" >> .env.local
echo "SPYFU_DEFAULT_DOMAIN=nolandsroofing.com" >> .env.local

# Restart dev server
npm run dev
```

`.env.local` is gitignored. Never commit.

## Smoke test (once configured)

```bash
curl -H "x-dispatch-secret: $INTERNAL_DISPATCH_SECRET" \
  https://demo.voxaris.io/api/internal/spyfu-sync \
  | jq '.domainStats'
```

Expected response shape:
```json
{
  "ok": true,
  "domain": "nolandsroofing.com",
  "pulledAt": "2026-05-27T17:30:00.000Z",
  "domainStats": {
    "ok": true,
    "organicKeywords": 920,
    "paidKeywords": 453,
    "estMonthlyAdBudget": 23120,
    ...
  },
  "paidKeywords": { "ok": true, "keywords": [...] },
  "organicKeywords": { "ok": true, "keywords": [...] },
  "competitors": { "ok": true, "organicCompetitors": [...], "paidCompetitors": [...] },
  "adWasteDetection": { "ok": true, "estWastedMonthly": 11472, "flaggedKeywords": [...] }
}
```

## What you can pull live (beyond the PDF)

The PDF gave you a snapshot. The API gives you:

| Endpoint | Use case |
|---|---|
| `getDomainStats` | Weekly refresh of the page-2 SpyFu overview |
| `getTopPaidKeywords` (limit 100) | Track every keyword AIM is bidding on, week over week |
| `getTopOrganicKeywords` (limit 100) | Detect rank slips before they cost Noland's traffic |
| `getCompetitors` | When a new competitor enters the auction, you see it on the dashboard |
| `detectAdWaste` | Auto-flag every keyword AIM is overpaying on (the $11.5K/mo Quality-Score Tax) |

The Intel Brief was a snapshot. With the API live, the **Recoverable GP**
table updates itself daily. Greg can log in tomorrow and see what AIM
spent yesterday + what we flagged as waste.

## Future endpoints to add (v2)

- **Ad History API** — month-by-month ad creative snapshots (we showed
  this in Intel Brief page 9 from the PDF; the API can pull the full
  18-year archive)
- **Domain Crawl** — backlink updates (currently we have 5; SpyFu's
  full backlink corpus is much deeper)
- **SERP API** — track Noland's position daily for the 7 emergency
  keywords (`noland's roofing reviews`, `roofing clermont fl`, etc.)
- **Keyword Difficulty API** — surfaces which "Great Buy" keywords are
  defensible long-term vs short-term wins

Add these to `lib/spyfu.ts` once the basic 5 endpoints are validated
against the live data.
