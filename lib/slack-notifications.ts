/**
 * lib/slack-notifications.ts — real-time Slack channel observability.
 *
 * Posts every new_lead / appt_scheduled / call_completed event to a
 * Slack channel via an Incoming Webhook so the operator team can SEE
 * activity as it happens — instead of refreshing the dashboard or
 * tailing Vercel logs.
 *
 * ── Design posture ────────────────────────────────────────────────
 *
 * Soft-fail on every path. A Slack outage, malformed webhook URL, or
 * 4xx from Slack must NEVER break lead capture, voice dispatch, or
 * post-call SMS. The send is fire-and-forget at the caller — this
 * module returns a Promise but the caller voids it.
 *
 * Slack expects POST JSON with `{ text, blocks? }`. The Block Kit
 * `blocks` array produces the rich card; `text` is the fallback that
 * shows on mobile push notifications when blocks aren't rendered.
 *
 * Reuses the LeadWebhookEvent shape from lib/lead-webhook.ts so the
 * two call sites (new_lead + call_completed) pass the same object.
 *
 * ── Env config ────────────────────────────────────────────────────
 *
 *   SLACK_WEBHOOK_URL          — required. Slack Incoming Webhook URL.
 *                                Setup: api.slack.com/apps → Create
 *                                App → Incoming Webhooks → Add to
 *                                channel → copy URL.
 *
 * ── Security ──────────────────────────────────────────────────────
 *
 * The webhook URL is the only credential. Anyone who has it can post
 * to the channel — treat as sensitive, never log the value. We DO
 * NOT enforce HMAC on outbound (Slack doesn't accept it), but we
 * gate on the URL being on Slack's domain to make accidental
 * misconfig harder (e.g. someone pasting an attacker URL into
 * SLACK_WEBHOOK_URL on Vercel — refuse).
 *
 * Slack-specific URL pattern:
 *   https://hooks.slack.com/services/T.../B.../...
 *
 * Reject anything else. If the operator needs to point this at a
 * different webhook system (Discord, Teams), they should add a
 * separate module — don't loosen the Slack URL guard.
 */

import type { LeadWebhookEvent } from "./lead-webhook";

const SLACK_HOOK_HOSTNAME = "hooks.slack.com";

/** True iff the URL is a Slack incoming webhook (hooks.slack.com over HTTPS). */
function isSlackWebhookUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    return url.hostname.toLowerCase() === SLACK_HOOK_HOSTNAME;
  } catch {
    return false;
  }
}

/** Format a money amount as $XXk for compact display. */
function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `$${Math.round(n / 1000)}k`;
  return `$${n}`;
}

/** Mask the middle of a phone for the public-facing message — full
 *  number stays in the dashboard, the Slack ping shows last 4 only. */
function maskPhone(raw: string | null): string {
  if (!raw) return "—";
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return "—";
  return `••• ${digits.slice(-4)}`;
}

/** Map an outcome string to an emoji + human label. */
function outcomeBadge(outcome: string | undefined): {
  emoji: string;
  label: string;
} {
  switch ((outcome ?? "").toLowerCase()) {
    case "appt_scheduled":
    case "booked":
      return { emoji: "📅", label: "Booked" };
    case "callback_requested":
    case "transferred":
      return { emoji: "↪️", label: "Transferred / callback" };
    case "no_appointment":
    case "logged_lead":
      return { emoji: "📝", label: "Logged — no appt" };
    case "voicemail":
      return { emoji: "🎙️", label: "Voicemail" };
    case "failed":
      return { emoji: "❌", label: "Failed" };
    default:
      return { emoji: "•", label: outcome ?? "unknown" };
  }
}

/** Build Slack Block Kit payload for new_lead events. */
function buildNewLeadBlocks(ev: LeadWebhookEvent): {
  text: string;
  blocks: unknown[];
} {
  const { lead, office } = ev;
  const estimateRange =
    lead.estimate_low != null && lead.estimate_high != null
      ? `${fmtMoney(lead.estimate_low)}–${fmtMoney(lead.estimate_high)}`
      : "no estimate yet";
  const fallbackText = `🚨 New lead — ${lead.name} (${lead.address}) — ${estimateRange}`;
  return {
    text: fallbackText,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🚨 New lead",
          emoji: true,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Name*\n${lead.name}` },
          { type: "mrkdwn", text: `*Phone*\n${maskPhone(lead.phone_raw)}` },
          { type: "mrkdwn", text: `*Address*\n${lead.address}` },
          { type: "mrkdwn", text: `*Estimate*\n${estimateRange}` },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `📍 *${office.display_name}* · ${lead.source ?? "estimator"} · ${new Date(ev.occurred_at).toLocaleString("en-US", { timeZone: "America/New_York" })} ET`,
          },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open lead", emoji: true },
            url: lead.report_url,
            style: "primary",
          },
        ],
      },
    ],
  };
}

/** Build Slack Block Kit payload for call_started events.
 *  Shorter than call_ended — just "Sarah is dialing X right now" so
 *  the team sees the outbound moment as it happens. */
function buildCallStartedBlocks(ev: LeadWebhookEvent): {
  text: string;
  blocks: unknown[];
} {
  const { lead, office } = ev;
  const extras = (ev.extras ?? {}) as { direction?: string };
  const direction =
    (extras.direction ?? "outbound").toLowerCase() === "inbound"
      ? "📞 Inbound call"
      : "📲 Sarah dialing";
  const fallbackText = `${direction} — ${lead.name} (${lead.address})`;
  return {
    text: fallbackText,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: direction, emoji: true },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Lead*\n${lead.name}` },
          { type: "mrkdwn", text: `*Phone*\n${maskPhone(lead.phone_raw)}` },
          { type: "mrkdwn", text: `*Address*\n${lead.address}` },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `📍 *${office.display_name}* · ${new Date(ev.occurred_at).toLocaleString("en-US", { timeZone: "America/New_York" })} ET`,
          },
        ],
      },
    ],
  };
}

/** Build Slack Block Kit payload for appt_scheduled / call_completed events. */
function buildCallEndedBlocks(ev: LeadWebhookEvent): {
  text: string;
  blocks: unknown[];
} {
  const { lead, office } = ev;
  const extras = (ev.extras ?? {}) as {
    outcome?: string;
    appointment_at?: string | null;
    summary?: string | null;
  };
  const badge = outcomeBadge(extras.outcome);
  const apptLine = extras.appointment_at
    ? `*Appt time*\n${new Date(extras.appointment_at).toLocaleString("en-US", { timeZone: "America/New_York" })} ET`
    : `*Outcome*\n${badge.label}`;
  const fallbackText = `${badge.emoji} ${badge.label} — ${lead.name} (${lead.address})`;
  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${badge.emoji} Sarah call · ${badge.label}`,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Lead*\n${lead.name}` },
        { type: "mrkdwn", text: `*Address*\n${lead.address}` },
        { type: "mrkdwn", text: apptLine },
        { type: "mrkdwn", text: `*Phone*\n${maskPhone(lead.phone_raw)}` },
      ],
    },
  ];
  if (extras.summary && extras.summary.trim().length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Summary*\n>${extras.summary.replace(/\n/g, "\n>")}`,
      },
    });
  }
  blocks.push(
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `📍 *${office.display_name}* · ${new Date(ev.occurred_at).toLocaleString("en-US", { timeZone: "America/New_York" })} ET`,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open lead", emoji: true },
          url: lead.report_url,
          style: "primary",
        },
      ],
    },
  );
  return { text: fallbackText, blocks };
}

/**
 * Post one lead/call event to the configured Slack channel.
 *
 * Returns `{ ok: true }` on 2xx, `{ ok: false, reason }` on any
 * failure. Caller MUST void the promise — this never throws.
 */
export async function sendSlackLeadEvent(
  ev: LeadWebhookEvent,
): Promise<{ ok: true } | { ok: false; reason: string } | null> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return null;
  if (!isSlackWebhookUrl(url)) {
    console.error(
      "[slack-notifications] refusing non-Slack webhook URL (must be hooks.slack.com over HTTPS)",
    );
    return { ok: false, reason: "unsafe_webhook_url" };
  }

  let payload: { text: string; blocks: unknown[] };
  switch (ev.event) {
    case "new_lead":
      payload = buildNewLeadBlocks(ev);
      break;
    case "call_started":
      payload = buildCallStartedBlocks(ev);
      break;
    case "appt_scheduled":
    case "call_completed":
      payload = buildCallEndedBlocks(ev);
      break;
    default:
      return { ok: false, reason: "unknown_event_type" };
  }

  try {
    // 5s timeout — Slack is typically ~200ms; anything over 5s is
    // either Slack outage or DNS hostile. We don't want the lead
    // capture path stalled on Slack.
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn("[slack-notifications] non-2xx", {
        status: res.status,
        body: body.slice(0, 200),
        event: ev.event,
        leadId: ev.lead.public_id,
      });
      return { ok: false, reason: `http_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.warn("[slack-notifications] fetch failed", {
      err: err instanceof Error ? err.message : String(err),
      event: ev.event,
      leadId: ev.lead.public_id,
    });
    return { ok: false, reason: "fetch_failed" };
  }
}
