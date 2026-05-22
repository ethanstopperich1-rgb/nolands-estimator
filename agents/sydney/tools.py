"""Sydney's three function tools.

`transfer_to_human` is REAL when the routing env vars are set — it dials the
appropriate on-call human via the LiveKit outbound SIP trunk and bridges them
into the caller's room. If the env vars are missing it falls back to a redacted
log line so the demo still works without escalation numbers configured.

`book_inspection` and `log_lead` are still mocked. Production work is to
replace them with JobNimbus API calls + Sendblue/Twilio SMS confirmation.
Both:
  - Return `status: "mock_*"` (e.g. mock_booked) — never plain `"booked"` —
    so the calling LLM can detect demo mode and tailor its next utterance
    rather than telling a real caller "you're confirmed."
  - Use confirmation/lead identifiers explicitly prefixed `MOCK-` so any
    downstream logs make it obvious these are not real CRM records.

Logging policy (post-review):
  - The previous `_banner` printed full PII (name/phone/email/address/notes)
    to stdout. Cloud logs are NOT a safe PII store. We now log a redacted
    line via the `sydney.tools` logger with:
      - first 12 chars of SHA-256 of any contact identifier (correlation
        without the underlying value)
      - structural metadata (lead_type, service_type, time_window, office)
      - lengths of free-text fields rather than the text itself
  - Full PII still flows to CRM downstreams when those are wired up; that's
    the only place it should land in production.
"""

from __future__ import annotations

import hashlib
import logging
import os
from typing import Annotated, Any

from livekit import agents, api, rtc
from livekit.agents import function_tool

logger = logging.getLogger("sydney.tools")

# Must match WorkerOptions.agent_name in agent.py for /api/agent/events routing.
_AGENT_EVENTS_NAME = os.environ.get("SYDNEY_AGENT_NAME_EVENTS", "sydney")

_TWILIO_PATH_HINT = (
    "PSTN leg is Twilio (Elastic SIP trunk); SIP response codes on failures "
    "usually indicate trunk IP ACL, origination/termination, or caller-ID."
)


async def _emit_tool_fired(tool: str, summary: dict[str, Any]) -> None:
    """Best-effort dashboard row in `events` — never blocks tool return.

    Also records a semantic outcome for the current room (book_inspection
    → 'booked', etc.) so agent.py's shutdown can set call_ended.outcome
    to something useful instead of the default 'unknown'.
    """
    ctx = agents.get_job_context()
    if ctx is None:
        return
    try:
        import events as _events
        from datetime import datetime

        # Map the tool name to a call-outcome enum. Tools that aren't an
        # outcome signal in themselves (check_availability) intentionally
        # don't have an entry — they shouldn't promote the outcome.
        _TOOL_TO_OUTCOME = {
            "book_inspection": "booked",
            "transfer_to_human": "transferred",
            "log_lead": "logged_lead",
        }
        outcome = _TOOL_TO_OUTCOME.get(tool)
        if outcome:
            _events.record_outcome(ctx.room.name, outcome)

        summary = {**summary, "twilio_path_hint": _TWILIO_PATH_HINT}
        await _events.post(
            {
                "type": "tool_fired",
                "agent_name": _AGENT_EVENTS_NAME,
                "room_name": ctx.room.name,
                "tool": tool,
                "summary": summary,
                "at": datetime.utcnow().isoformat() + "Z",
            }
        )
    except Exception:
        pass


def _hash_fragment(value: str | None) -> str | None:
    """SHA-256 first 12 chars — enough to correlate log lines, opaque
    enough that the underlying value can't be recovered from the log.
    Empty / None passes through as None."""
    if not value:
        return None
    return hashlib.sha256(value.strip().lower().encode("utf-8")).hexdigest()[:12]


def _is_after_hours() -> bool:
    """True when the current Eastern Time falls outside Noland's office
    hours (Mon-Fri 8am-5pm). Used to source-attribute Sarah's JN writes
    so the office can ROI-track after-hours lead capture distinctly
    from web-form estimator submissions.

    Mirrors the logic in agent.py:pick_opener() so the source tag and
    the verbatim opener never disagree about which mode we're in."""
    from datetime import datetime as _dt
    from zoneinfo import ZoneInfo as _ZI
    now = _dt.now(_ZI("America/New_York"))
    is_weekday = now.weekday() < 5
    is_business_hours = 8 <= now.hour < 17
    return not (is_weekday and is_business_hours)


def _resolve_source(base_label: str) -> str:
    """Resolve the source_name tag for a JN contact write based on
    when the call is happening. After-hours calls land in JN as
    "Sarah After Hours" so Noland's reporting can split:

      - "Voxaris Estimator"  → web-form leads (form submission path)
      - "Sarah After Hours"  → inbound calls Sarah handled overnight /
                               weekend (no live rep available)
      - "Sarah Inbound"      → business-hours inbound calls Sarah
                               handled (rep was unavailable / call
                               overflow / overnight catchup)

    Override per-deployment via JOBNIMBUS_SOURCE_AFTER_HOURS /
    JOBNIMBUS_SOURCE_INBOUND env vars when a contractor wants their
    own taxonomy strings.

    `base_label` is the legacy default the caller would have used
    pre-attribution (kept for backward compat / non-call code paths
    like outbound estimator follow-up which already pass "Voxaris
    Estimator · {lead_type}")."""
    if _is_after_hours():
        return os.environ.get("JOBNIMBUS_SOURCE_AFTER_HOURS", "Sarah After Hours")
    # Business-hours inbound also gets attributed — every Sarah-handled
    # call should be tagged so the office can measure call-volume vs
    # web-form lead capture independently.
    return os.environ.get("JOBNIMBUS_SOURCE_INBOUND", base_label)


def _log_tool_call(title: str, redacted_summary: dict) -> None:
    """Structured single-line log of a tool invocation.

    `redacted_summary` MUST be already redacted by the caller — this
    helper does not strip PII itself. Designed for cloud log retention
    where any PII written is effectively persistent.
    """
    logger.info("tool_fired tool=%s summary=%s", title, redacted_summary)


def _existing_jobnimbus_contact_id() -> str | None:
    """Pull `jobnimbusContactId` from the current job's metadata.

    The estimator pushes new leads into JobNimbus on form-submit + V3
    paint success (see nolands-estimator/app/api/gemini-roof/route.ts).
    The returned `jnid` is stored on the lead row and threaded through
    /api/dispatch-outbound into Sydney's job metadata.

    When this returns a non-empty string, book_inspection / log_lead
    SKIP the create_contact step and use this existing contact —
    preventing duplicate JobNimbus records for the same homeowner.

    Returns None when:
      - not running inside a LiveKit job (unit tests, inbound calls
        where no estimator push happened)
      - lead_context wasn't passed in metadata (inbound dispatch)
      - jobnimbusContactId field is empty/null (estimator-side push
        failed or JOBNIMBUS_API_KEY was unset on the estimator side)

    Soft-fail philosophy: any failure here returns None and the tool
    creates a fresh contact, same as before. No crashes.
    """
    try:
        ctx = agents.get_job_context()
        if ctx is None:
            return None
        raw_meta = getattr(getattr(ctx, "job", None), "metadata", None) or ""
        if not raw_meta:
            return None
        import json as _json

        parsed = _json.loads(raw_meta)
        if not isinstance(parsed, dict):
            return None
        value = parsed.get("jobnimbusContactId")
        if isinstance(value, str) and value.strip():
            return value.strip()
        return None
    except Exception:
        return None


# Routing — set in LK Cloud Agent secrets.
# Empty / unset means: tool falls back to mock-banner mode (still pitch-safe).
SIP_OUTBOUND_TRUNK_ID = os.environ.get("SIP_OUTBOUND_TRUNK_ID", "")
ESCALATION_NUMBERS = {
    "emergency": os.environ.get("ESCALATION_EMERGENCY_PHONE", ""),
    "warranty": os.environ.get("ESCALATION_WARRANTY_PHONE", ""),
    "sales": os.environ.get("ESCALATION_SALES_PHONE", ""),
    "general": os.environ.get("ESCALATION_GENERAL_PHONE", ""),
}

# Caller-ID we present to the on-call human. The Twilio number Sydney's
# project owns is the safest default — the human sees Noland's calling.
TRANSFER_CALLER_ID = os.environ.get("TRANSFER_CALLER_ID", "+13219851104")

# Allowlists — the LLM is schema-guided to send only these values, but a
# malicious / drifted model could pass anything. We hard-validate before
# any external dial, so a creative `reason` like "+15551234567" can't
# route the call to an attacker-controlled number.
VALID_REASONS = {"emergency", "warranty", "sales", "general"}
VALID_PRIORITIES = {"low", "normal", "urgent"}

# E.164 — leading "+", country code, up to 15 digits. Used to validate
# every routing number we read from env before we hand it to SIP.
import re as _re
_E164_RE = _re.compile(r"^\+[1-9]\d{1,14}$")


def _is_valid_e164(number: str | None) -> bool:
    return bool(number) and bool(_E164_RE.match(number or ""))


@function_tool
async def transfer_to_human(
    reason: Annotated[str, "One of: emergency, warranty, sales, general"],
    priority: Annotated[str, "One of: low, normal, urgent"],
    caller_summary: Annotated[str, "Short description of the caller's situation and what they need"],
) -> dict:
    """Connect the caller to a real human teammate.

    Use this when:
    - The caller has active water intrusion or any roofing emergency (priority="urgent").
    - The caller is an existing customer with a service or warranty issue.
    - The caller explicitly asks to speak to a person.
    - The situation is outside Sydney's scope (insurance pushback, complex pricing).

    Always tell the caller "let me get you to someone who can help, one moment"
    BEFORE invoking this tool.
    """
    # Hard-validate the LLM-supplied `reason` / `priority` against allowlists.
    # The schema annotation is a guideline — a malicious or drifted model
    # could pass arbitrary strings. Rejecting unknown values prevents:
    #   - routing to an attacker-controlled number via a creative `reason`
    #     that happens to match an env var
    #   - escalation-tier confusion ("urgent" vs "URGENT" vs "high")
    if reason not in VALID_REASONS:
        logger.warning("transfer_to_human rejected reason=%r (not in allowlist)", reason)
        reason = "general"
    if priority not in VALID_PRIORITIES:
        logger.warning("transfer_to_human normalized priority=%r → normal", priority)
        priority = "normal"

    target = ESCALATION_NUMBERS.get(reason, "") or ESCALATION_NUMBERS.get("general", "")

    # Validate the target number is E.164 before we hand it to SIP. A bad
    # env value (or operator typo) shouldn't result in a malformed dial.
    if target and not _is_valid_e164(target):
        logger.error(
            "transfer_to_human refusing to dial — ESCALATION_%s_PHONE is not "
            "E.164 (value rejected). Set a number like +15551234567.",
            reason.upper(),
        )
        target = ""

    # Validate caller-ID — must be E.164 AND an owned number. We can't
    # check ownership at runtime, but we CAN enforce the format.
    if not _is_valid_e164(TRANSFER_CALLER_ID):
        logger.error(
            "transfer_to_human refusing to dial — TRANSFER_CALLER_ID is not "
            "E.164 (got %r). Set a project-owned number like +13219851104.",
            TRANSFER_CALLER_ID,
        )
        target = ""

    # Redacted log — caller_summary may contain incidental PII (the caller
    # describing their situation). We log a length + hash for correlation,
    # not the contents. `target` is hashed too because cloud logs aren't a
    # safe place to keep on-call humans' personal numbers either.
    _log_tool_call("transfer_to_human", {
        "reason": reason,
        "priority": priority,
        "caller_summary_len": len(caller_summary or ""),
        "target_hash": _hash_fragment(target),
        "trunk_configured": bool(SIP_OUTBOUND_TRUNK_ID),
    })

    # Mock fallback — keeps the demo working without real numbers.
    if not target or not SIP_OUTBOUND_TRUNK_ID:
        logger.warning(
            "transfer_to_human in MOCK mode (target=%r trunk=%r) — set "
            "ESCALATION_%s_PHONE and SIP_OUTBOUND_TRUNK_ID for real bridging",
            target, SIP_OUTBOUND_TRUNK_ID, reason.upper(),
        )
        await _emit_tool_fired(
            "transfer_to_human",
            {
                "status": "transferred_mock",
                "queue": reason,
                "priority": priority,
                "trunk_configured": bool(SIP_OUTBOUND_TRUNK_ID),
                "target_configured": bool(target),
            },
        )
        return {"status": "transferred_mock", "queue": reason, "priority": priority}

    # Real bridge: dial the on-call human into the same room as the caller.
    # Both stay in the room; Sydney's session can then exit so the humans talk
    # freely. Pattern follows livekit-examples/warm_handoff.
    try:
        ctx = agents.get_job_context()
        if ctx is None:
            logger.warning("transfer_to_human: no job context, falling back to mock")
            await _emit_tool_fired(
                "transfer_to_human",
                {
                    "status": "transferred_mock",
                    "queue": reason,
                    "priority": priority,
                    "note": "no_job_context",
                },
            )
            return {"status": "transferred_mock", "queue": reason, "priority": priority}

        await ctx.api.sip.create_sip_participant(
            api.CreateSIPParticipantRequest(
                room_name=ctx.room.name,
                sip_trunk_id=SIP_OUTBOUND_TRUNK_ID,
                sip_call_to=target,
                sip_number=TRANSFER_CALLER_ID,
                participant_identity=f"specialist-{reason}",
                participant_name=f"Noland's {reason.title()} Specialist",
                krisp_enabled=True,
                # Block until the specialist actually picks up. If they don't,
                # we get a TwirpError below and the model can fall back to
                # offering the caller a callback or scheduler.
                wait_until_answered=True,
            )
        )
        logger.info(
            "transfer_to_human BRIDGED reason=%s target=%s room=%s",
            reason, target, ctx.room.name,
        )
        await _emit_tool_fired(
            "transfer_to_human",
            {
                "status": "transferred",
                "queue": reason,
                "priority": priority,
                "method": "dial_and_bridge",
                "target_hash": _hash_fragment(target),
            },
        )
        return {
            "status": "transferred",
            "queue": reason,
            "priority": priority,
            "method": "dial_and_bridge",
        }
    except api.TwirpError as e:
        sip_code = e.metadata.get("sip_status_code") if e.metadata else None
        logger.warning(
            "transfer_to_human dial FAILED reason=%s sip=%s msg=%s",
            reason, sip_code, e.message,
        )
        await _emit_tool_fired(
            "transfer_to_human",
            {
                "status": "transfer_failed",
                "queue": reason,
                "error": "specialist_unavailable",
                "sip_status_code": sip_code,
                "twirp_message": (e.message or "")[:240],
            },
        )
        return {
            "status": "transfer_failed",
            "queue": reason,
            "error": "specialist_unavailable",
            "sip_status_code": sip_code,
        }
    except Exception as e:
        logger.warning("transfer_to_human unexpected: %s", e)
        await _emit_tool_fired(
            "transfer_to_human",
            {
                "status": "transfer_failed",
                "queue": reason,
                "error": "unexpected",
                "detail": str(e)[:240],
            },
        )
        return {"status": "transfer_failed", "queue": reason, "error": str(e)}


# Production: routes through jobnimbus.py when JOBNIMBUS_API_KEY is set.
# Falls back to MOCK + dashboard event + lead webhook so the homeowner
# data is durably captured even before JN is wired or on JN failures.
# JobNimbus API: https://documentation.jobnimbus.com/
@function_tool
async def book_inspection(
    name: Annotated[str, "Caller's full name"],
    phone: Annotated[str, "Phone number, digits only"],
    email: Annotated[str, "Email address"],
    address: Annotated[str, "Property address including city, state, zip"],
    date: Annotated[str, "Appointment date in YYYY-MM-DD format"],
    time_window: Annotated[str, "Either 'morning' (9am-12pm) or 'afternoon' (1pm-5pm)"],
    office: Annotated[str, "One of: clermont, orange_city, bradenton, fort_myers"],
    service_type: Annotated[str, "One of: roof_repair, roof_replacement, renovation, storm_damage, other"],
    notes: Annotated[str, "Anything else relevant the specialist should know"],
) -> dict:
    """Schedule a free inspection on the calendar.

    Only call this AFTER you have read the appointment back to the caller and
    they confirmed it is correct. Do not call speculatively.
    """
    # Redacted log — full PII (name/phone/email/address/notes) goes to
    # JobNimbus when wired; cloud logs only get hashes for correlation.
    redacted = {
        "phone_hash": _hash_fragment(phone),
        "email_hash": _hash_fragment(email),
        "address_hash": _hash_fragment(address),
        "date": date,
        "time_window": time_window,
        "office": office,
        "service_type": service_type,
        "notes_len": len(notes or ""),
    }

    # Try JobNimbus first when configured. On ANY failure (no key,
    # network, API rejection), degrade to MOCK + dashboard event +
    # webhook so the lead never gets dropped silently.
    import asyncio
    from . import jobnimbus  # type: ignore[import-not-found]

    if jobnimbus.is_enabled():
        try:
            # Prefer the contact_id threaded through job metadata by
            # the estimator's V3 success path (when the homeowner came
            # in via the form). Skipping the create_contact call
            # prevents duplicate JN records for the same homeowner.
            existing_contact_id = _existing_jobnimbus_contact_id()
            if existing_contact_id:
                contact_id = existing_contact_id
                logger.info(
                    "jobnimbus reusing existing contact_id=%s from job metadata",
                    contact_id,
                )
            else:
                # No upstream contact_id → inbound call or estimator
                # push failed. Create the contact ourselves.
                parts = (name or "").strip().split(maxsplit=1)
                first_name = parts[0] if parts else "Unknown"
                last_name = parts[1] if len(parts) > 1 else "Unknown"

                # Source attribution: after-hours / business-hours
                # inbound → "Sarah After Hours" / "Sarah Inbound".
                # Outbound estimator follow-ups never hit this branch
                # (they reuse an existing contact_id from job metadata).
                contact_source = _resolve_source("Voxaris Estimator")
                contact = await asyncio.to_thread(
                    jobnimbus.create_contact,
                    first_name=first_name,
                    last_name=last_name,
                    phone=phone,
                    email=email or None,
                    address=address or None,
                    source=contact_source,
                    office=office,
                )
                contact_id = contact.get("id") or contact.get("contact_id") or ""
                if not contact_id:
                    raise jobnimbus.JobNimbusError(
                        f"contact create returned no id: {contact}"
                    )

            # 2. Create the job (work-order record). date_start stays
            #    empty here — Noland's reps don't use the job-level
            #    appointment fields. The calendar entry is the TASK
            #    we create in step 3.
            job = await asyncio.to_thread(
                jobnimbus.create_inspection_job,
                contact_id=contact_id,
                address=address,
                date_iso=date,
                time_window=time_window,
                service_type=service_type,
                notes=notes or "",
                office=office,
            )
            job_id = job.get("id") or job.get("job_id") or ""

            # 3. Create the calendar TASK. This is what actually shows
            #    up on the field rep's JN calendar. Without this step
            #    the job sits in the pipeline but no one sees the
            #    appointment in their schedule view.
            import datetime as _dt, zoneinfo as _zi
            try:
                tz = _zi.ZoneInfo("America/New_York")
                start_h = 9 if time_window == "morning" else 13
                start_dt = _dt.datetime.fromisoformat(date).replace(
                    hour=start_h, tzinfo=tz
                )
                # Convention from probing Noland's tasks: title is
                # "{address}-{name}" so the rep recognizes the entry
                # in their calendar feed.
                task_title = f"Measure Call-{address[:40]}-{name[:30]}"
                task_desc = (
                    f"Sydney booked {service_type} inspection.\n"
                    f"Contact: {name} ({phone})\n"
                    f"Window: {time_window} ({date})\n\n"
                    f"{notes or ''}"
                )
                # Default unrouted (owner=None). Office dispatcher
                # assigns to a specific rep from the unrouted-task
                # queue. Per-office default owner via env var when
                # the contractor wants automatic routing.
                import os as _os
                default_owner = _os.environ.get(
                    f"JOBNIMBUS_DEFAULT_OWNER_ID_{office.upper()}"
                ) or _os.environ.get("JOBNIMBUS_DEFAULT_OWNER_ID") or None

                task = await asyncio.to_thread(
                    jobnimbus.create_measure_call_task,
                    title=task_title,
                    date_start_unix=int(start_dt.timestamp()),
                    duration_minutes=60,
                    description=task_desc,
                    owner_id=default_owner,
                )
                task_id = task.get("jnid") or task.get("id") or ""
                logger.info(
                    "jobnimbus task created task_id=%s owner=%s",
                    task_id, default_owner or "(unrouted)",
                )
            except jobnimbus.JobNimbusError as e:
                # Task creation failure does NOT fail the booking —
                # contact + job were already saved. Log it; office will
                # see the lead even without the calendar entry.
                logger.warning("jobnimbus create_measure_call_task failed: %s", e)
                task_id = ""

            # 4. Attach Sydney's call summary as a note on the contact
            if notes:
                try:
                    await asyncio.to_thread(
                        jobnimbus.attach_note,
                        contact_id=contact_id,
                        job_id=None,
                        body=f"Sydney booked {service_type} inspection.\n\n{notes}",
                        title="Sydney Call Summary",
                    )
                except jobnimbus.JobNimbusError as e:
                    # Note attachment failure doesn't fail the booking.
                    logger.warning("jobnimbus attach_note failed: %s", e)

            redacted_real = {**redacted, "mode": "jobnimbus",
                             "contact_id": contact_id, "job_id": job_id,
                             "task_id": task_id}
            _log_tool_call("book_inspection", redacted_real)
            await _emit_tool_fired("book_inspection", redacted_real)
            return {
                "status": "booked",
                "confirmation_number": job_id or contact_id,
                "office": office,
            }
        except jobnimbus.JobNimbusError as e:
            # Soft-fail to MOCK. The lead is still captured via the
            # dashboard event + webhook below — operator triages from
            # the dashboard. The CALLER hears a confirmation regardless,
            # but the response includes demo_mode=True so the LLM knows
            # not to over-promise.
            logger.warning("jobnimbus book_inspection fell back to MOCK: %s", e)

    # MOCK path — either JOBNIMBUS_API_KEY unset or JN errored out.
    redacted_mock = {**redacted, "mode": "mock"}
    _log_tool_call("book_inspection", redacted_mock)
    await _emit_tool_fired("book_inspection", redacted_mock)
    return {
        "status": "mock_booked",
        "confirmation_number": "MOCK-NL-DEMO-12345",
        "office": office,
        "demo_mode": True,
    }


# Production: routes through jobnimbus.create_contact when configured.
# Same MOCK-fallback discipline as book_inspection.
@function_tool
async def log_lead(
    name: Annotated[str, "Caller's name (use 'unknown' if not collected)"],
    phone: Annotated[str, "Phone number"],
    email: Annotated[str, "Email if collected, empty string otherwise"],
    address: Annotated[str, "Address if collected, empty string otherwise"],
    notes: Annotated[str, "Why we're logging this lead and any context"],
    lead_type: Annotated[str, "One of: new_inspection, warranty_callback, outside_area, vendor, dnc, other"],
) -> dict:
    """Save the caller's info to the CRM as a lead.

    Call this after book_inspection succeeds, OR at the end of any call where
    you collected contact info but did not book an appointment (outside service
    area, warranty handoff, vendor / wrong number, DNC request, etc.).
    """
    redacted = {
        "phone_hash": _hash_fragment(phone),
        "email_hash": _hash_fragment(email),
        "address_hash": _hash_fragment(address),
        "notes_len": len(notes or ""),
        "lead_type": lead_type,
    }

    import asyncio
    from . import jobnimbus  # type: ignore[import-not-found]

    if jobnimbus.is_enabled():
        try:
            # Reuse the estimator-side contact when available (see
            # _existing_jobnimbus_contact_id docstring above). Skips
            # create_contact to avoid duplicate JN records.
            existing_contact_id = _existing_jobnimbus_contact_id()
            if existing_contact_id:
                contact = {"id": existing_contact_id, "contact_id": existing_contact_id}
                logger.info(
                    "jobnimbus log_lead reusing contact_id=%s from job metadata",
                    existing_contact_id,
                )
            else:
                parts = (name or "").strip().split(maxsplit=1)
                first_name = parts[0] if parts else "Unknown"
                last_name = parts[1] if len(parts) > 1 else "Lead"

                # Source attribution for log_lead path. Combine the
                # time-resolved label with the lead_type so the office
                # can filter "Sarah After Hours · warranty_callback"
                # separately from "Sarah After Hours · new_inspection".
                contact_source = (
                    f"{_resolve_source('Voxaris Estimator')} · {lead_type}"
                )
                contact = await asyncio.to_thread(
                    jobnimbus.create_contact,
                    first_name=first_name,
                    last_name=last_name,
                    phone=phone,
                    email=email or None,
                    address=address or None,
                    source=contact_source,
                    office=None,
                )
            contact_id = contact.get("id") or contact.get("contact_id") or ""

            # Attach the reason for logging
            if notes:
                try:
                    await asyncio.to_thread(
                        jobnimbus.attach_note,
                        contact_id=contact_id,
                        job_id=None,
                        body=f"Lead type: {lead_type}\n\n{notes}",
                        title="Sydney Lead Note",
                    )
                except jobnimbus.JobNimbusError as e:
                    logger.warning("jobnimbus log_lead note failed: %s", e)

            redacted_real = {**redacted, "mode": "jobnimbus",
                             "contact_id": contact_id}
            _log_tool_call("log_lead", redacted_real)
            await _emit_tool_fired("log_lead", redacted_real)
            return {
                "status": "logged",
                "lead_id": contact_id,
                "lead_type": lead_type,
            }
        except jobnimbus.JobNimbusError as e:
            logger.warning("jobnimbus log_lead fell back to MOCK: %s", e)

    redacted_mock = {**redacted, "mode": "mock"}
    _log_tool_call("log_lead", redacted_mock)
    await _emit_tool_fired("log_lead", redacted_mock)
    return {
        "status": "mock_logged",
        "lead_id": "MOCK-LEAD-DEMO-98765",
        "demo_mode": True,
    }


# ─── check_availability — Stage 5 of the outbound script ─────────────────
# Sydney's flow ends with: "Have her use a tool to check availability rather
# than guessing." This tool returns the next 5 business days of slot windows
# so Sydney can OFFER specific times ("I have Wednesday afternoon between
# 1-4, or Friday morning") instead of asking the caller what works for them.
#
# Demo behavior: hard-coded calendar — most slots open, a few "taken" so the
# response feels like a real calendar, not a script. Production will swap
# this for a JobNimbus / Google Calendar query that hits the actual office
# schedule. The mocked status flags ("mock_availability") let the LLM know
# it's still synthetic.
@function_tool
async def check_availability(
    office: Annotated[str, "One of: clermont, orange_city, bradenton, fort_myers"],
    earliest_date: Annotated[
        str,
        "Earliest date the caller can do, in YYYY-MM-DD. Use today's date if they said 'as soon as possible' or didn't specify.",
    ],
) -> dict:
    """Look up the next 5 business days of inspection slots for the office.

    Call this AFTER you've qualified the caller (Stage 3) and given them
    the value bridge (Stage 4). Use the returned `slots` array to OFFER
    two or three specific times — don't ask 'what works for you?'.
    """
    import datetime as _dt

    try:
        start = _dt.date.fromisoformat(earliest_date)
    except (ValueError, TypeError):
        start = _dt.date.today()

    # Build the next 5 business-day windows from `start`. Skip weekends.
    slots: list[dict] = []
    d = start
    while len(slots) < 5:
        if d.weekday() < 5:  # Mon=0..Fri=4
            slots.append({
                "date": d.isoformat(),
                "day_name": d.strftime("%A"),
                "windows": [
                    {"window": "morning", "label": "9 AM – 12 PM", "status": "open"},
                    {"window": "afternoon", "label": "1 PM – 4 PM", "status": "open"},
                ],
            })
        d += _dt.timedelta(days=1)

    # ─── Real calendar reads (when JobNimbus is wired) ────────────────
    # Try to fetch actual scheduled jobs from JN for this office across
    # the slot window. Mark any overlapping morning/afternoon as
    # "taken". On ANY failure (no key, network, malformed response)
    # fall through to the synthetic friction below so Sydney still
    # has plausible offerings rather than every slot reading "open" —
    # better customer experience than a hung tool.
    import asyncio as _asyncio
    import datetime as __dt
    import zoneinfo as _zi

    # tools.py is imported two ways in this repo:
    #   - As `from . import tools` from agent.py (package context exists)
    #   - As `import tools` from tests + LiveKit Cloud runtime (no package)
    # Try absolute first (covers tests + runtime), fall back to relative
    # (covers the agent.py case where the package context is intact).
    try:
        import jobnimbus  # type: ignore[import-not-found]
    except ImportError:
        from . import jobnimbus  # type: ignore[import-not-found]

    real_mode = "mock"
    if jobnimbus.is_enabled() and slots:
        try:
            # Compute the UNIX timestamp range covering all returned
            # slots. America/New_York is hardcoded for FL deployments;
            # multi-tz support would key off office's local tz.
            tz = _zi.ZoneInfo("America/New_York")
            first_date = __dt.date.fromisoformat(slots[0]["date"])
            last_date = __dt.date.fromisoformat(slots[-1]["date"])
            range_start = __dt.datetime.combine(
                first_date, __dt.time(0, 0), tzinfo=tz
            )
            range_end = __dt.datetime.combine(
                last_date, __dt.time(23, 59), tzinfo=tz
            )
            # Query TASKS (not jobs) — Noland's calendar lives on the
            # tasks endpoint. Jobs don't carry date_start in their
            # org. The "Measure Call" record_type is the inspection
            # appointment; "Appointment" is the generic catch-all.
            tasks = await _asyncio.to_thread(
                jobnimbus.search_tasks_by_date_range,
                start_unix=int(range_start.timestamp()),
                end_unix=int(range_end.timestamp()),
                # Default tuple in jobnimbus.py covers Measure Call +
                # variants + generic Appointment. Don't broaden to
                # Phone Call etc. — those don't block field-rep
                # availability.
            )

            # Bucket task timestamps into (date, window) pairs.
            # Morning = task starts in [9:00, 12:00). Afternoon =
            # task starts in [12:00, 17:00). Anything outside is
            # ignored for slot-painting purposes (after-hours / break).
            taken: set[tuple[str, str]] = set()
            for task in tasks:
                ds = task.get("date_start")
                if not isinstance(ds, (int, float)) or ds <= 0:
                    continue
                local = __dt.datetime.fromtimestamp(ds, tz=tz)
                hr = local.hour
                if 9 <= hr < 12:
                    taken.add((local.date().isoformat(), "morning"))
                elif 12 <= hr < 17:
                    taken.add((local.date().isoformat(), "afternoon"))

            # Apply the taken set to the slot grid.
            for slot in slots:
                for window in slot["windows"]:
                    if (slot["date"], window["window"]) in taken:
                        window["status"] = "taken"

            real_mode = "jobnimbus"
            logger.info(
                "check_availability used JobNimbus: tasks_in_window=%d "
                "windows_taken=%d office=%s",
                len(tasks),
                len(taken),
                office,
            )
        except jobnimbus.JobNimbusError as e:
            logger.warning(
                "jobnimbus check_availability fell back to MOCK: %s", e
            )
            real_mode = "mock"
        except Exception as e:
            # Defensive — never let availability lookup error out
            # the voice loop. Fall through to mock-friction below.
            logger.warning(
                "check_availability unexpected error, falling back to MOCK: %s",
                e,
            )
            real_mode = "mock"

    # MOCK friction — applied only when JN didn't return real data.
    # Sydney still offers a plausible calendar instead of "every slot
    # open forever" which would feel scripted.
    if real_mode == "mock":
        if slots:
            slots[0]["windows"][0]["status"] = "taken"
        if len(slots) >= 3:
            slots[2]["windows"][1]["status"] = "taken"

    _log_tool_call("check_availability", {
        "office": office,
        "earliest_date": earliest_date,
        "slots_returned": len(slots),
        "mode": real_mode,
    })

    return {
        "status": "real_availability" if real_mode == "jobnimbus" else "mock_availability",
        "office": office,
        "slots": slots,
        "demo_mode": real_mode == "mock",
    }


# ─── identify_caller — Phase 0 of INBOUND calls ───────────────────────
# Sarah's FIRST action on every inbound call: look up the caller's
# phone in JobNimbus to differentiate new homeowners from existing
# customers. Drives the warmth + skip-redundant-intake branch in the
# prompt. Returns a structured snapshot the LLM uses to choose the
# right opener follow-up.


@function_tool
async def identify_caller(
    phone: Annotated[
        str,
        "Caller's phone number as the call arrived (any format — E.164, raw 10-digit, formatted). Comes from the SIP From header or your runtime context.",
    ],
) -> dict:
    """Look up an inbound caller in JobNimbus by phone number.

    Call this SILENTLY at the very start of every inbound call —
    BEFORE asking the caller's name or address. It tells you whether
    they're an existing customer (skip redundant intake, branch by
    job status) or a brand-new homeowner (run standard Phase 1-5).

    Returns:
      status: "new_caller" | "existing_active" | "existing_won" |
              "existing_lost" | "existing_lead" | "lookup_failed"
      display_name: str | None — full name on file (use first name)
      sales_rep_name: str | None — the rep currently on their file
      latest_job_status: str | None — pipeline stage of their newest job
      recent_note_count: int — how many recent notes attached to it

    Sarah behavior rules:
      - NEW caller (status=new_caller or lookup_failed): standard
        intake. Don't reference any prior history.
      - EXISTING caller: warmly acknowledge by first name. Reference
        the assigned rep by name ("looks like Raymond is on your
        file"). NEVER quote prior notes verbatim — context only.
      - status=existing_won (Contract Awarded / Paid & Closed):
        loyalty warmth, transfer to warranty if they have an issue.
      - status=existing_lost (Lost-Dead / Lost-Competitor): recovery
        handler. "I see we talked before — happy to take another look?"
    """
    import asyncio
    from . import jobnimbus  # type: ignore[import-not-found]

    if not jobnimbus.is_enabled():
        return {"status": "lookup_failed", "reason": "jobnimbus_not_configured"}

    try:
        result = await asyncio.to_thread(
            jobnimbus.lookup_contact_by_phone,
            phone=phone,
            recent_notes_limit=2,
        )
    except Exception as e:
        logger.warning("identify_caller unexpected: %s", e)
        return {"status": "lookup_failed", "reason": str(e)[:120]}

    if not result.get("found"):
        # No PII logged — just the lookup miss for debug telemetry.
        _log_tool_call("identify_caller", {
            "phone_hash": _hash_fragment(phone),
            "status": "new_caller",
        })
        return {"status": "new_caller"}

    # Bucket the contact into one of four existing-caller states based
    # on their newest job's pipeline status. This is the field the
    # LLM branches on for warmth + warranty / recovery routing.
    job_status = (result.get("latest_job_status") or "").strip()
    if job_status in ("Contract Awarded", "Paid & Closed", "Final Invoice Sent"):
        bucket = "existing_won"
    elif job_status.startswith("Lost"):
        bucket = "existing_lost"
    elif job_status.startswith("Lead") or job_status in (
        "Appointment Scheduled",
        "Scope Pending",
        "Estimating",
        "Decision Pending",
        "Follow Up 03 Days",
        "Follow Up 07 Days",
        "Inside Sales 03 Days",
        "Inside Sales 07 Days",
        "Inside Sales 15 Days",
    ):
        bucket = "existing_lead"
    elif job_status in ("Order Materials", "Pending Estimate", "Reschedule"):
        bucket = "existing_active"
    else:
        # Contact exists but no recognizable job status — likely a
        # past customer with the job closed long ago. Treat as won
        # for warmth posture.
        bucket = "existing_won" if result.get("display_name") else "new_caller"

    # Log a hashed event for ops telemetry. Don't log PII.
    _log_tool_call("identify_caller", {
        "phone_hash": _hash_fragment(phone),
        "status": bucket,
        "rep": result.get("sales_rep_name"),
        "job_status": job_status,
        "note_count": result.get("recent_note_count", 0),
    })

    return {
        "status": bucket,
        "display_name": result.get("display_name"),
        "sales_rep_name": result.get("sales_rep_name"),
        "latest_job_status": job_status or None,
        "recent_note_count": result.get("recent_note_count", 0),
        # Notes are NOT returned to the LLM — Sarah uses context, not
        # quotes. Surface only the COUNT so she can say "I see we've
        # spoken before" not "you told us X on Tuesday."
    }


ALL_TOOLS = [
    identify_caller,
    transfer_to_human,
    check_availability,
    book_inspection,
    log_lead,
]
