# Telephony onboarding scripts

Wires up a Twilio toll-free / local number to LiveKit Cloud + the
Voxaris dispatch route. Use this on every new contractor deployment.

## What gets created

By the end of running these three scripts you'll have:

1. A **Twilio Elastic SIP Trunk** with the phone number associated
2. A **LiveKit inbound trunk + outbound trunk + dispatch rule** for
   that number, pointing at the `sydney` agent
3. **All env vars populated** in your local `.env.local` and (if you
   pass `--push-vercel`) Vercel production
4. **End-to-end smoke-test confirmation** that an outbound call can
   be placed and that Sydney answers

Designed to be runnable end-to-end in under 10 minutes on a fresh
machine.

## Prerequisites (one-time)

- Twilio account with a verified toll-free number (toll-free SMS
  verification is enough for testing; voice trust + SHAKEN/STIR is
  required before production traffic to avoid "Spam Likely" tags)
- LiveKit Cloud project with the `sydney` agent deployed
- `twilio` CLI installed: `brew install twilio/brew/twilio`
- `lk` CLI installed: `brew install livekit-cli`
- `vercel` CLI installed + logged in (only needed for `--push-vercel`)

## Authentication (one-time)

Both CLIs store credentials in your OS keychain — never paste them in
chat or commit them to the repo.

```sh
twilio login    # prompts for SID + auth token
lk cloud auth   # opens browser
vercel login    # browser-based
```

## Running the scripts

```sh
# Phase 1: Twilio SIP trunk (creates trunk, origination, credential
# list, attaches phone number). Outputs the IDs needed for Phase 2.
./scripts/telephony/01-twilio-sip-setup.sh +18887869134

# Phase 2: LiveKit inbound + outbound trunk + dispatch rule.
# Reads the Twilio output from Phase 1.
./scripts/telephony/02-livekit-sip-setup.sh

# Phase 3: Smoke test — confirms env vars are populated, dispatches
# a test call to a number you provide, verifies Sydney answered.
./scripts/telephony/03-smoke-test.sh +1xxxxxxxxxx
```

Each script writes a small state file under `scripts/telephony/.state/`
so Phase 2 can read Phase 1's IDs without you copy-pasting. That
directory is gitignored — never commit it.

## Where the credentials end up

| Surface | Stored as |
|---|---|
| Twilio CLI auth | macOS keychain |
| LiveKit CLI auth | `~/.livekit/` |
| SIP trunk username/password | macOS keychain via `security add-generic-password`; mirrored to `.env.local` |
| Vercel production env vars | Pushed via `vercel env add` (interactive) |

**Nothing sensitive lives in this repo, in this terminal scrollback,
or in any AI assistant's context.** The scripts deliberately use
`read -s` (silent input) for any value that's a secret, and
`security add-generic-password` to stash the SIP trunk credential
list on disk only inside the macOS keychain.

## Reference

- Root `AGENTS.md` → Telephony section — env-var landscape +
  compliance gates
- `app/api/dispatch-outbound/route.ts` — the dispatch route these
  scripts target
- `app/api/_health/route.ts` — runs after these scripts to verify
  env-var population
