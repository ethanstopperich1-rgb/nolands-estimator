/**
 * POST /api/agent/events
 *
 * Telemetry sink for Sydney (the LiveKit AI voice agent). Sydney POSTs
 * structured JSON here for every call_started / call_ended / tool_fired
 * event. The route writes to the Supabase `calls` and `events` tables so
 * Noland's reps can see call history in the dashboard.
 *
 * Auth: HMAC-SHA256 over the raw request body, sent in the
 * `X-Agent-Signature: sha256=<hex>` header. Signing is done in
 * `agents/sydney/events.py` using `AGENT_EVENTS_SECRET`.
 *
 * Failure behavior: Sydney soft-fails on any non-2xx. This route returns
 * 200 on every valid+authenticated payload (even if the Supabase write
 * fails). We never block voice call flow on telemetry.
 *
 * Idempotency: call_started checks for an existing calls row by room_name
 * before inserting — LiveKit rooms are unique per dispatch, so double-posts
 * are not expected but the guard is cheap insurance.
 *
 * Office resolution: this endpoint is Noland's-specific (the nolands-estimator
 * Vercel project). The office slug "nolands" is hardwired; Sydney doesn't
 * send an office field in its event payloads.
 *
 * Lead linkage: dispatch-outbound names rooms `outbound-<leadPublicId>-<ts>`.
 * We parse the public_id out of room_name and look up the internal lead UUID.
 * Inbound calls (SIP inbound, no leadId in room_name) get call rows with
 * lead_id = null.
 */

import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createServiceRoleClient,
  resolveOfficeBySlug,
} from "@/lib/supabase";

export const runtime = "nodejs";
// Short ceiling — this is purely a database write, not a long-running job.
export const maxDuration = 10;

// ─── Signature verification ────────────────────────────────────────────
// Sydney signs: "sha256=" + hmac.new(secret, body, sha256).hexdigest()
// (hex, not base64 — different from the lead-webhook signature format)

function verifySig(rawBody: string, signature: string, secret: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ─── Lead-ID parser ────────────────────────────────────────────────────
// Room names for outbound dispatches: outbound-<leadPublicId>-<timestamp>
// e.g. outbound-lead_abc123...def-1748000000000
const OUTBOUND_ROOM_RE = /^outbound-(lead_[0-9a-f]{32})-\d+$/i;

function parseleadPublicId(roomName: string): string | null {
  const m = roomName.match(OUTBOUND_ROOM_RE);
  return m ? m[1] : null;
}

// ─── Event handlers ────────────────────────────────────────────────────

type SB = ReturnType<typeof createServiceRoleClient>;

async function handleCallStarted(
  sb: SB,
  officeId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const roomName = payload.room_name as string;

  // Idempotency guard — room names should be unique per dispatch but this
  // is a cheap select before insert.
  const { data: existing } = await sb
    .from("calls")
    .select("id")
    .eq("office_id", officeId)
    .eq("room_name", roomName)
    .maybeSingle();
  if (existing) return;

  // Resolve lead_id from room_name if this was an outbound dispatch.
  let leadId: string | null = null;
  const leadPublicId = parseleadPublicId(roomName);
  if (leadPublicId) {
    const { data: lead } = await sb
      .from("leads")
      .select("id")
      .eq("public_id", leadPublicId)
      .eq("office_id", officeId)
      .maybeSingle();
    leadId = lead?.id ?? null;
  }

  const { error } = await sb.from("calls").insert({
    office_id: officeId,
    lead_id: leadId,
    agent_name: (payload.agent_name as string | null) ?? "sydney",
    room_name: roomName,
    caller_number: (payload.caller_number as string | null) ?? null,
    started_at: (payload.started_at as string | null) ?? new Date().toISOString(),
  });

  if (error) {
    console.error("[agent-events] call_started insert failed", {
      room_name: roomName,
      error: error.message,
    });
  }
}

async function handleCallEnded(
  sb: SB,
  officeId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const roomName = payload.room_name as string;

  // Find the existing calls row.
  const { data: call } = await sb
    .from("calls")
    .select("id")
    .eq("office_id", officeId)
    .eq("room_name", roomName)
    .maybeSingle();

  if (!call) {
    // Race condition or inbound call without a prior call_started. Create
    // the row now so we don't lose the call record entirely.
    await handleCallStarted(sb, officeId, {
      ...payload,
      type: "call_started",
      started_at: payload.ended_at, // best approximation
    });
  }

  const { error } = await sb
    .from("calls")
    .update({
      ended_at: payload.ended_at as string | null,
      duration_sec: typeof payload.duration_sec === "number" ? payload.duration_sec : null,
      turn_count: typeof payload.turn_count === "number" ? payload.turn_count : null,
      outcome: (payload.outcome as string | null) ?? null,
      transcript: (payload.transcript as string | null) ?? null,
      summary: (payload.summary as string | null) ?? null,
      llm_prompt_tokens: typeof payload.llm_prompt_tokens === "number" ? payload.llm_prompt_tokens : null,
      llm_completion_tokens: typeof payload.llm_completion_tokens === "number" ? payload.llm_completion_tokens : null,
      tts_chars: typeof payload.tts_chars === "number" ? payload.tts_chars : null,
      stt_secs: typeof payload.stt_secs === "number" ? payload.stt_secs : null,
      estimated_cost_usd: typeof payload.estimated_cost_usd === "number" ? payload.estimated_cost_usd : null,
    })
    .eq("office_id", officeId)
    .eq("room_name", roomName);

  if (error) {
    console.error("[agent-events] call_ended update failed", {
      room_name: roomName,
      error: error.message,
    });
  }
}

async function handleToolFired(
  sb: SB,
  officeId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const roomName = payload.room_name as string;

  // Resolve the call_id for the events FK (nullable — tool_fired without
  // a preceding call_started is unusual but possible on retries).
  const { data: call } = await sb
    .from("calls")
    .select("id")
    .eq("office_id", officeId)
    .eq("room_name", roomName)
    .maybeSingle();

  const { error } = await sb.from("events").insert({
    office_id: officeId,
    call_id: call?.id ?? null,
    type: "tool_fired",
    // Cast via unknown — Supabase's generated Json type is a deep recursive
    // union that TypeScript can't narrow from Record<string, unknown>.
    // JSON.parse(JSON.stringify(...)) ensures no non-serialisable values land
    // in the jsonb column.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload: JSON.parse(JSON.stringify({
      tool: String(payload.tool ?? ""),
      agent_name: String(payload.agent_name ?? ""),
      summary: payload.summary ?? null,
    })) as any,
    at: (payload.at as string | null) ?? new Date().toISOString(),
  });

  if (error) {
    console.error("[agent-events] tool_fired insert failed", {
      room_name: roomName,
      tool: payload.tool,
      error: error.message,
    });
  }
}

// ─── Route handler ─────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const secret = process.env.AGENT_EVENTS_SECRET ?? "";

  if (secret) {
    const sig = req.headers.get("x-agent-signature") ?? "";
    if (!verifySig(rawBody, sig, secret)) {
      console.warn("[agent-events] signature mismatch — rejecting POST");
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } else {
    // No secret configured: warn once per cold start, accept without auth.
    // This should only happen in local dev where AGENT_EVENTS_SECRET is unset.
    console.warn("[agent-events] AGENT_EVENTS_SECRET not set — running unauthenticated");
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { type, room_name } = payload;
  if (typeof type !== "string" || typeof room_name !== "string" || !type || !room_name) {
    return NextResponse.json({ error: "missing_fields: type, room_name" }, { status: 400 });
  }

  // Resolve Noland's office — this endpoint is hardwired to office "nolands".
  const office = await resolveOfficeBySlug("nolands");
  if (!office) {
    // If the office row doesn't exist yet, log and accept (don't fail Sydney's call).
    console.error("[agent-events] office 'nolands' not found in DB — skipping write");
    return NextResponse.json({ ok: true });
  }

  const sb = createServiceRoleClient();

  try {
    if (type === "call_started") {
      await handleCallStarted(sb, office.id, payload);
    } else if (type === "call_ended") {
      await handleCallEnded(sb, office.id, payload);
    } else if (type === "tool_fired") {
      await handleToolFired(sb, office.id, payload);
    } else {
      // Unknown event type — log but return 200 so Sydney doesn't retry.
      console.warn("[agent-events] unknown event type", { type });
    }
  } catch (err) {
    // Soft-fail: DB write failed, but we already verified auth and parsed the
    // payload. Return 200 so Sydney's fire-and-forget path doesn't loop.
    console.error("[agent-events] unhandled error", {
      type,
      room_name,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return NextResponse.json({ ok: true });
}
