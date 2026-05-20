# FL Contractor Intelligence Pipeline

Produces **CSV files** you can open in Excel, Google Sheets, or upload straight to Instantly. No database required.

Aligned with [MARKETING.md](../MARKETING.md): Estimator wedge only in copy. **Contact emails:** Apollo (recommended) or website scrape fallback.

## Setup (one time)

```sh
cd /Users/voxaris/voxaris-pitch
python3 -m venv .venv-intel
source .venv-intel/bin/activate
pip install -r scripts/requirements-contractor-intel.txt
```

## Run → get CSVs

```sh
npm run intel:pipeline
```

Or:

```sh
PYTHONPATH=scripts/contractor-intel .venv-intel/bin/python scripts/contractor-intel/run_pipeline.py
```

Smoke test (20 companies, Orlando only):

```sh
.venv-intel/bin/python scripts/contractor-intel/run_pipeline.py --limit 20 --metros orlando
```

## Output files (in `output/`)

| File | What it is |
|------|------------|
| **`contractor_prospects_latest.csv`** | Full enriched list — sort/filter in Excel |
| **`instantly_fl_roofing_latest.csv`** | Top ~200 ranked leads — **upload this to Instantly** |
| `review_fl_roofing_YYYYMMDD.csv` | Same as Instantly + QA columns |
| `contractor_seed_YYYYMMDD.csv` | DBPR-filtered seed (before scrape) |

Stable `*_latest.csv` paths are overwritten each run so you always know where to look.

## Instantly upload

1. Open `output/instantly_fl_roofing_latest.csv`
2. Campaign → Leads → Upload CSV
3. Map `email` → Email (required)
4. Map custom vars: `personalization_hook`, `demo_url`, `first_name`, `company_name`, …

## Re-export without re-scraping

After editing the master spreadsheet or re-running scoring:

```sh
npm run intel:export
```

Reads `output/contractor_prospects_latest.csv` by default.

## Free enrichment (default) — pattern + Hunter + SMTP

No Apollo credits. This is the **default** (`--enrich auto` or `--enrich free`).

Per contractor:

1. **DBPR** → owner name (`licensee_name`, e.g. `PATTERSON, RICK H`)
2. **Google Places** → website domain
3. **Light scrape** → any `info@` or named email on site
4. **Hunter.io** (optional, 25 searches/mo free) → domain pattern + indexed emails
5. **Construct** → `first@`, `first.last@`, `firstlast@`, `flast@` from owner name
6. **Verify** → Hunter email-verifier if key set, else **SMTP RCPT** (mailtester-style)

```sh
# Optional — saves Hunter credits on pattern step
HUNTER_API_KEY=your_hunter_key

npm run intel:pipeline:free -- --limit 20 --metros orlando
```

| Flag | Meaning |
|------|---------|
| `--enrich free` | Pattern + verify only |
| `--enrich free-scrape` | Free first, then site scrape for gaps |
| `--enrich apollo` | Paid Apollo (set `INTEL_PREFER_APOLLO=1` for auto→Apollo) |

**Manual steps the script does not do (yet):** Sunbiz officer lookup, LinkedIn contact info, Google PDF dorks, FRSA directory. Add owner name from Sunbiz if DBPR name is a holding company.

**Rate limits:** SMTP verification sleeps ~2s between attempts — a 20-company run may take 15–30 min.

---

## Data sources (what each API does)

| API | Role | Gives you |
|-----|------|-----------|
| **DBPR** | Seed list | Licensed FL roofing contractors (CCC) |
| **Google Places** | Website + phone | Domain for enrichment |
| **Apollo** | Contacts | Owner/GM **emails** (credits) |
| **BuiltWith** | Stack / ICP | JobNimbus, AccuLynx, ServiceTitan, etc. (credits) |
| **Scrape** | Fallback | Slow; generic `info@` emails |

BuiltWith does **not** replace Apollo for emails — use both: Apollo for outreach, BuiltWith for scoring and personalization (“saw you’re on JobNimbus…”).

## BuiltWith

1. API key from [api.builtwith.com](https://api.builtwith.com/)
2. `.env.local`:

```bash
BUILTWITH_API_KEY=your_key_here
```

3. Runs automatically with `--stack auto` (default) after websites are found.

```sh
PYTHONPATH=scripts/contractor-intel python scripts/contractor-intel/run_pipeline.py \
  --limit 20 --metros orlando --enrich apollo --stack builtwith
```

- **Domain API (`v22`)** — full technology list, up to 16 domains per request (~1 credit/domain on most plans).
- **Free API (`--stack free`)** — category counts only; no JobNimbus-level detail.

Stack hits feed `lead_score` (see `STACK_KEYWORDS` in `config.py`).

## Apollo (recommended)

1. Create a **master** API key: [Apollo → Settings → Integrations → API](https://app.apollo.io/#/settings/integrations/api)
2. Add to `.env.local`:

```bash
APOLLO_API_KEY=your_master_key_here
```

3. Run Apollo-only enrichment (no slow site scrape):

```sh
npm run intel:pipeline:apollo -- --limit 50 --metros orlando
```

**Credits:** People Search is free; `people/bulk_match` uses export/enrichment credits (~1 per contact with email). For 200 leads, budget ~200 credits.

| `--enrich` | Behavior |
|------------|----------|
| `auto` (default) | Apollo if `APOLLO_API_KEY` set, else scrape |
| `apollo` | Apollo only — fast, owner/GM emails |
| `scrape` | Website scrape only (no credits) |
| `apollo-first` | Apollo then scrape gaps |

## Env vars

| Variable | Required | Purpose |
|----------|----------|---------|
| `APOLLO_API_KEY` | For Apollo mode | Owner/GM emails (master key) |
| `GOOGLE_SERVER_KEY` or `NEXT_PUBLIC_GOOGLE_MAPS_KEY` | Recommended | Find contractor websites |
| `SUPABASE_DB_URL` | No | Only if you pass `--save-db` |
| `INTEL_TOP_N` | No | Default `200` |
| `CONTACT_EMAIL` | No | Scraper User-Agent contact |

## Optional: save to Supabase

```sh
npm run intel:pipeline -- --save-db
```

Requires migration `0006_contractor_prospects.sql` applied and `SUPABASE_DB_URL` set.

## CloakBrowser

Used when DBPR download or contractor sites block plain HTTP. See [CloakHQ/CloakBrowser](https://github.com/CloakHQ/CloakBrowser.git).

## Compliance

- B2B email: CAN-SPAM in your Instantly templates
- Do not use `scripts/skip_trace.py` for this pipeline
- Scrape only contractor-owned sites; respect robots.txt
