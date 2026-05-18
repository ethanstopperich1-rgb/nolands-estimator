# Production Alerts Runbook

Console-only setup. None of these live in the repo — they're configured
in the Vercel, Google Cloud, and Sentry dashboards. This file tracks
what's required so a re-set or new environment can be rebuilt from
scratch.

## 1. Billing alerts — $50 / $200 / $1000

Three thresholds per platform. The $50 fires early enough to catch a
runaway loop in dev; $200 means a real abuse incident or buggy
deploy; $1000 is "drop everything, pull the route."

### 1a. Vercel (project-level)

Project → **Settings → Billing → Spend Management → Add alert**.

| Threshold | Channel | Recipient |
| --- | --- | --- |
| $50 | Email | ethan.stopperich1@gmail.com |
| $200 | Email + Slack | ethan + #voxaris-ops |
| $1000 | Email + SMS | ethan (407) 819-5809 |

Toggle **Spend Pause** at $1500 (hard ceiling — Vercel halts function
invocations until manually un-paused).

### 1b. Google Gemini (AI Studio / Google Cloud project)

Generative Language API quota lives in Google Cloud — alerts are set
on the same project that hosts the API key.

Cloud Console → **Billing → Budgets & alerts → Create budget**.

- Budget name: `voxaris-gemini`
- Scope: project containing `GEMINI_API_KEY`
- Filter: services = `Generative Language API`
- Amount: `$1000` monthly
- Alert thresholds: `5%` ($50), `20%` ($200), `100%` ($1000) of budget
  → email ethan.stopperich1@gmail.com

### 1c. Google Cloud (catch-all on all services)

Same Console → **Billing → Budgets & alerts → Create budget**.

- Budget name: `voxaris-gcp-all`
- Scope: same project
- Filter: (no service filter — all services)
- Amount: `$1000` monthly
- Alert thresholds: `5% / 20% / 100%`
- Email: ethan.stopperich1@gmail.com

Covers Maps Static, Places, Solar, BigQuery, and any service that
slips in later (e.g. Vertex AI experiments).

## 2. Sentry alert — 5xx spike on /api/gemini-roof pages Ethan

Sentry → **Alerts → Create Alert Rule** → choose project
`voxaris-pitch`.

- Type: **Metric Alert**
- Metric: `event.count`
- Filter (search query):
  ```
  url:"*api/gemini-roof*" event.type:transaction transaction.status:internal_error
  ```
  Or equivalently for plain errors:
  ```
  url:"*api/gemini-roof*" http.status_code:>=500
  ```
- Time window: `5 minutes`
- Trigger:
  - **Critical** when count > `5` in 5 min → action: Email
    `ethan.stopperich1@gmail.com` + SMS via PagerDuty / Twilio
- Cooldown: 15 minutes (avoid alert storms)

PagerDuty / SMS step: if PagerDuty isn't wired yet, set the Sentry
integration to send to a personal email-to-SMS gateway
(`5xx@voxaris-pager.example`) so the alert paginates Ethan directly.
Goal: phone buzzes within 60 seconds of the 6th 5xx.

## 3. Verification checklist

After each alert is configured, force a test trigger and confirm
the recipient gets the message:

- [ ] Vercel $50 alert — bump a project budget temporarily to $0.01,
      run one deployment, watch for the email
- [ ] Gemini $50 alert — set test threshold to $0.01 on the
      generative budget, make one API call, confirm
- [ ] GCP $50 alert — same, on the catch-all budget
- [ ] Sentry rule — submit 6 synthetic 5xx events via `sentry-cli send-event`
      against `/api/gemini-roof`, confirm the email + SMS fire
