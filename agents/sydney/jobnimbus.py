"""JobNimbus API client for Sydney.

When JOBNIMBUS_API_KEY is set in the environment, book_inspection and
log_lead in tools.py route through this module to create real records.
When unset (or any call fails), tools.py falls back to MOCK mode AND
fires the dashboard event + the lead webhook — so even in mock mode
the homeowner data is captured durably.

Production wiring lives in tools.py (the @function_tool callables);
this file is the pure JobNimbus surface — no LiveKit context, no
LLM concerns. Stays testable.

API reference: https://documentation.jobnimbus.com

Endpoint base: https://app.jobnimbus.com/api1/

Auth: HTTP header `Authorization: Bearer <JOBNIMBUS_API_KEY>` per
JobNimbus's REST API. JobNimbus also supports a query-param form
(?api_key=...) but bearer is the modern path.

Resources we use:
  - POST /contacts           → create homeowner contact
  - POST /jobs               → create job (the appointment/inspection)
  - GET  /jobs?display_name= → search existing jobs for a contact
  - POST /workorders         → create the actual appointment record
  - POST /tasks              → fallback when the office prefers tasks

NOTE: the JobNimbus API does NOT have a stable "appointment" resource
distinct from jobs. The pattern in production is:
  1. POST a Contact (homeowner)
  2. POST a Job (the inspection — with date_start as the appointment)
  3. Attach a Note with Sydney's call summary
  4. (optional) POST a Task for the field rep
"""

from __future__ import annotations

import logging
import os
import urllib.request
import urllib.error
import json
from typing import Any
from datetime import datetime, timezone

logger = logging.getLogger("sydney.jobnimbus")

JOBNIMBUS_API_KEY = os.environ.get("JOBNIMBUS_API_KEY", "")
JOBNIMBUS_BASE_URL = os.environ.get(
    "JOBNIMBUS_BASE_URL", "https://app.jobnimbus.com/api1"
)

# Timeout — keep tight; tool calls can't block voice latency.
_TIMEOUT_SEC = 5.0


def is_enabled() -> bool:
    """True when JobNimbus is configured; False = fall back to MOCK."""
    return bool(JOBNIMBUS_API_KEY)


class JobNimbusError(Exception):
    """Raised when JobNimbus returns an error response. Caller in
    tools.py catches this and falls back to MOCK mode + logs a
    structured failure event so ops can see the failure rate."""


def _request(
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Synchronous JobNimbus request. Called via asyncio.to_thread
    from the @function_tool to keep the voice loop responsive.

    Raises JobNimbusError on non-2xx OR network failure. Caller is
    expected to catch + degrade gracefully (MOCK fallback)."""
    if not JOBNIMBUS_API_KEY:
        raise JobNimbusError("JOBNIMBUS_API_KEY not set")

    url = f"{JOBNIMBUS_BASE_URL.rstrip('/')}/{path.lstrip('/')}"
    body = json.dumps(payload).encode("utf-8") if payload else None
    headers = {
        "Authorization": f"Bearer {JOBNIMBUS_API_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SEC) as resp:
            text = resp.read().decode("utf-8")
            if resp.status >= 400:
                raise JobNimbusError(
                    f"{method} {path} returned {resp.status}: {text[:300]}"
                )
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as e:
        body_preview = ""
        try:
            body_preview = e.read().decode("utf-8")[:300]
        except Exception:
            pass
        raise JobNimbusError(
            f"{method} {path} HTTP {e.code}: {body_preview}"
        ) from e
    except urllib.error.URLError as e:
        raise JobNimbusError(f"{method} {path} network: {e.reason}") from e
    except Exception as e:
        raise JobNimbusError(f"{method} {path} unexpected: {e}") from e


# ─── Resource methods ─────────────────────────────────────────────────


# JobNimbus calendar architecture (Noland's deployment, May 2026):
#
#   /contacts → homeowner records (we create these)
#   /jobs     → the work order (we create these; date_start stays empty)
#   /tasks    → the calendar entries (THE actual schedule)
#
# Reps see /tasks on their JN calendar view. A "Measure Call" task is
# the inspection appointment — record_type_name="Measure Call" + a real
# date_start/date_end timestamp + owners=[{id:<user>}] for the rep.
#
# Other task record_type_name values in Noland's vocabulary:
#   Phone Call (31%), Measure Call (18%), Task (17%), TIME OFF (6%),
#   Adjuster Meeting (5%), Meeting (5%), Appointment (4%), Final Sales,
#   Upload Permit/NOC, F&F-Measure Call, Self Gen-Measure Call, Install.
#
# Tasks do NOT link to contacts or jobs via the `primary` field (probed
# 200 tasks: zero with primary populated). They live as standalone
# calendar entries owned by users. To attach context (the contact's
# name + address) we put it in `title` / `description`.
#
# Caveat: there is no /users endpoint to resolve owner IDs → display
# names. Owners stay as opaque IDs until JN exposes a user resolver
# or we map IDs to names per office via JOBNIMBUS_OWNERS_<OFFICE> env.
# For Sarah's writes today we leave owners unset → the task lands in
# Noland's unrouted-tasks queue and the dispatcher assigns it to a rep.


_MEASURE_CALL_RECORD_TYPES = (
    "Measure Call",
    "Self Gen-Measure Call",
    "F&F -Measure Call",
    "Appointment",
)


def lookup_contact_by_phone(*, phone: str, recent_notes_limit: int = 3) -> dict[str, Any]:
    """Identify an inbound caller by phone number.

    Used by Sarah at the start of every inbound call to differentiate
    new homeowners (full intake required) from existing customers
    (skip redundant questions, branch by status, optionally read
    prior context).

    Returns a dict shape:
      {
        "found": bool,
        "jnid": str | None,
        "display_name": str | None,
        "status_name": str | None,           # "New" / "Active"
        "record_type_name": str | None,      # "Homeowner" / "Business"
        "source_name": str | None,
        "latest_job_jnid": str | None,
        "latest_job_status": str | None,     # e.g. "Contract Awarded"
        "sales_rep_name": str | None,
        "recent_note_count": int,
        "recent_notes": [{ "body": str, "author": str, "date": int }],
      }

    Match strategy: JN normalizes mobile_phone across formats, so we
    search by the last 10 digits (US numbers). This catches +1xxxxx,
    (xxx) xxx-xxxx, xxx-xxx-xxxx, and bare 10-digit entries.

    Returns {"found": False} when no key configured or no match.
    NEVER raises — caller path must never break on a lookup miss."""
    import re as _re
    import urllib.parse as _urlparse

    if not is_enabled():
        return {"found": False}

    # Normalize input phone to last 10 digits (US E.164 → strip +1).
    digits = _re.sub(r"\D", "", phone or "")
    if len(digits) > 10:
        digits = digits[-10:]
    if len(digits) < 10:
        return {"found": False}

    try:
        # JN indexes home_phone + work_phone for the `match` clause but
        # NOT mobile_phone (probed May 2026 — mobile_phone match returns
        # 0 even when the value is on the contact row). bool.should
        # union of all three captures whichever field the rep entered
        # the number into. minimum_should_match: 1 = OR semantics.
        #
        # IMPORTANT: urlencode + a pre-quoted filter value double-encodes
        # the percent signs and JN returns 0. urlencode handles the
        # quoting for us — pass the raw JSON string and let it encode.
        filter_json = json.dumps({
            "must": [{
                "bool": {
                    "should": [
                        {"match": {"home_phone": digits}},
                        {"match": {"work_phone": digits}},
                        {"match": {"mobile_phone": digits}},
                    ],
                    "minimum_should_match": 1,
                },
            }],
        })
        qs = _urlparse.urlencode({"filter": filter_json, "size": "5"})
        resp = _request("GET", f"/contacts?{qs}")
        results = (
            resp.get("results")
            if isinstance(resp, dict)
            else (resp if isinstance(resp, list) else [])
        ) or []
        if not results:
            return {"found": False}

        # Pick the most recently updated contact (rep workflow: the
        # active one). JN doesn't expose a "modified desc" order
        # parameter consistently, so sort client-side.
        contact = max(
            results,
            key=lambda c: c.get("date_updated") or c.get("date_created") or 0,
        )
        jnid = contact.get("jnid")
        result: dict[str, Any] = {
            "found": True,
            "jnid": jnid,
            "display_name": contact.get("display_name") or "",
            "status_name": contact.get("status_name") or None,
            "record_type_name": contact.get("record_type_name") or None,
            "source_name": contact.get("source_name") or None,
            "sales_rep_name": contact.get("sales_rep_name") or None,
            "latest_job_jnid": None,
            "latest_job_status": None,
            "recent_note_count": 0,
            "recent_notes": [],
        }

        # Best-effort: pull the most-recent job for status context.
        # If JN errors on this, return what we have — no exception.
        try:
            job_filter_json = json.dumps({
                "must": [{"match": {"primary_contact_id": jnid}}],
            })
            job_qs = _urlparse.urlencode({"filter": job_filter_json, "size": "5"})
            job_resp = _request("GET", f"/jobs?{job_qs}")
            jobs = (
                job_resp.get("results") if isinstance(job_resp, dict) else []
            ) or []
            if jobs:
                latest_job = max(
                    jobs,
                    key=lambda j: j.get("date_updated") or 0,
                )
                result["latest_job_jnid"] = latest_job.get("jnid")
                result["latest_job_status"] = latest_job.get("status_name")
                # Override sales_rep_name from job when contact-level
                # is unset (jobs carry the assigned rep more reliably).
                if not result["sales_rep_name"]:
                    result["sales_rep_name"] = latest_job.get("sales_rep_name")
        except Exception as e:
            logger.info("lookup_contact_by_phone: job lookup soft-failed: %s", e)

        # Recent notes — bounded by recent_notes_limit. Notes attach
        # to jobs (primary.type=job) in Noland's org, not to contacts
        # directly. Skip if we don't have a job_jnid.
        if recent_notes_limit > 0 and result["latest_job_jnid"]:
            try:
                note_filter_json = json.dumps({
                    "must": [
                        {"match": {"record_type_name": "Note"}},
                        {"match": {"primary.id": result["latest_job_jnid"]}},
                    ],
                })
                note_qs = _urlparse.urlencode({
                    "filter": note_filter_json,
                    "size": str(recent_notes_limit),
                })
                note_resp = _request("GET", f"/activities?{note_qs}")
                notes = (
                    note_resp.get("activity")
                    if isinstance(note_resp, dict)
                    else None
                ) or (
                    note_resp.get("results")
                    if isinstance(note_resp, dict)
                    else []
                ) or []
                # Sort newest first
                notes_sorted = sorted(
                    notes,
                    key=lambda n: n.get("date_created") or 0,
                    reverse=True,
                )[:recent_notes_limit]
                result["recent_note_count"] = len(notes_sorted)
                result["recent_notes"] = [
                    {
                        "body": (n.get("note") or "").strip()[:400],
                        "author": n.get("created_by_name") or "",
                        "date": n.get("date_created") or 0,
                    }
                    for n in notes_sorted
                ]
            except Exception as e:
                logger.info("lookup_contact_by_phone: notes lookup soft-failed: %s", e)

        return result

    except JobNimbusError as e:
        logger.info("lookup_contact_by_phone JN error: %s", e)
        return {"found": False}
    except Exception as e:
        logger.warning("lookup_contact_by_phone unexpected: %s", e)
        return {"found": False}


def search_tasks_by_date_range(
    *,
    start_unix: int,
    end_unix: int,
    record_types: tuple[str, ...] | None = None,
    office: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """List tasks scheduled in [start_unix, end_unix] (UNIX seconds).

    THIS is the function check_availability should call to know which
    slots are booked. Tasks are JN's canonical calendar entries; jobs
    don't carry date_start in Noland's org.

    Filter shape (Elasticsearch DSL):
      {"must": [
        {"range": {"date_start": {"gte": <unix>, "lte": <unix>}}},
        {"terms": {"record_type_name": ["Measure Call", ...]}}  // optional
      ]}

    record_types: tuple of task types to count as "busy". Defaults to
        the inspection-style types Sarah should avoid double-booking
        (Measure Call + variants + generic Appointment). Pass None to
        match all task types (catches Phone Call, Meeting, Final Sales,
        etc. as busy too — usually too aggressive).
    office: kept for signature symmetry with search_jobs_by_date_range.
        Currently ignored; per-office calendar isolation requires a
        per-office user-ID allowlist we don't have wired yet."""
    import urllib.parse as _urlparse

    types_to_match = record_types if record_types is not None else _MEASURE_CALL_RECORD_TYPES
    must: list[dict[str, Any]] = [
        {
            "range": {
                "date_start": {"gte": start_unix, "lte": end_unix},
            }
        },
    ]
    if types_to_match:
        # JN's Elasticsearch parser does NOT support the `terms` clause
        # (returns 0 results silently). Use bool.should with one match
        # per value instead — empirically verified May 2026 against
        # Noland's live data.
        must.append({
            "bool": {
                "should": [
                    {"match": {"record_type_name": t}}
                    for t in types_to_match
                ],
                "minimum_should_match": 1,
            }
        })
    filter_json = json.dumps({"must": must})
    params = {"filter": filter_json, "size": str(limit)}
    qs = _urlparse.urlencode(params)
    path = f"/tasks?{qs}"

    logger.info(
        "jobnimbus search_tasks date_range=[%d, %d] types=%s",
        start_unix, end_unix, types_to_match,
    )
    response = _request("GET", path)
    if isinstance(response, dict):
        results = response.get("results") or response.get("activity") or []
    else:
        results = response if isinstance(response, list) else []
    if not isinstance(results, list):
        return []
    return results


def create_measure_call_task(
    *,
    title: str,
    date_start_unix: int,
    duration_minutes: int = 60,
    description: str = "",
    owner_id: str | None = None,
    record_type_name: str = "Measure Call",
) -> dict[str, Any]:
    """Create a Measure Call task on JN's calendar.

    title: shows on the rep's calendar — convention is
        "{address}-{homeowner name}" so the rep recognizes it at a glance.
    date_start_unix: appointment start, UNIX seconds.
    duration_minutes: defaults to 60 (1-hour inspection window). Noland's
        typical Measure Call is 30-60 min.
    description: Sarah's full call summary lands here.
    owner_id: JN user_id of the field rep. None → unrouted (lands in
        the office's task queue, dispatcher assigns manually).
    record_type_name: "Measure Call" by default. Override to
        "Self Gen-Measure Call" for door-knock leads or "F&F -Measure
        Call" for friends-and-family referrals if the office wants
        attribution segmentation.

    Returns the JN task response with jnid. Raises JobNimbusError on
    failure — caller MUST fall through to MOCK + still create the
    contact/job so the homeowner isn't lost.

    Schema notes:
      - JN's /tasks POST returns the created task with jnid.
      - date_end is derived from date_start + duration_minutes since
        JN doesn't auto-fill it from a duration field.
      - hide_from_calendarview=False is the default — task SHOULD show
        on the rep's calendar UI.
      - hide_from_tasklist=False is the default — task shows in the
        task-list dashboard view too.
    """
    payload: dict[str, Any] = {
        "record_type_name": record_type_name,
        "title": title[:120],
        "description": description[:5000] if description else "",
        "date_start": int(date_start_unix),
        "date_end": int(date_start_unix) + int(duration_minutes) * 60,
        "all_day": False,
        "priority": 0,
        "is_completed": False,
        "hide_from_calendarview": False,
        "hide_from_tasklist": False,
    }
    # Owner resolution order:
    #   1. Explicit owner_id arg (per-office routing, when known)
    #   2. JOBNIMBUS_NEW_LEAD_OWNER_IDS — full intake team tagged as
    #      co-owners. Every team member sees the appointment on their
    #      calendar feed + gets notified. Standing rule for Noland's
    #      until per-office routing is in.
    if owner_id:
        payload["owners"] = [{"id": owner_id}]
    else:
        _owner_ids_raw = os.environ.get("JOBNIMBUS_NEW_LEAD_OWNER_IDS", "")
        _owner_ids = [s.strip() for s in _owner_ids_raw.split(",") if s.strip()]
        if _owner_ids:
            payload["owners"] = [{"id": oid} for oid in _owner_ids]

    logger.info(
        "jobnimbus create_measure_call_task title=%s date_start=%d duration=%dm owner=%s",
        title[:30], date_start_unix, duration_minutes, owner_id or "(unrouted)",
    )
    return _request("POST", "/tasks", payload)


def search_jobs_by_date_range(
    *,
    start_unix: int,
    end_unix: int,
    office: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """List jobs scheduled in [start_unix, end_unix] (UNIX timestamps,
    seconds). Used by check_availability to mark windows as "taken"
    when a JobNimbus job already overlaps.

    Returns a list of jobs (raw JN shape). Empty list when:
      - no jobs in range
      - JN unconfigured (caller already gated with is_enabled)
      - the search call errors and the caller swallows
    Raises JobNimbusError on auth / network / 5xx — caller catches
    and falls back to the MOCK calendar (see tools.py check_availability).

    Filter shape per JobNimbus REST docs (Elasticsearch DSL):
      {"must": [{"range": {"date_start": {"gte": <unix>, "lte": <unix>}}}]}

    Office filtering: was previously a `sales_rep_name: "Sydney ({office})"`
    match clause. Removed May 2026 after probing Noland's real JN org —
    sales_rep_name holds the field rep's real name (Nathan Mitchell,
    Raymond Aviles, Gregory Noland, …), NOT a "Sydney ({office})" marker.
    The match was filtering out 100% of real jobs, making check_availability
    silently mock-only. The office argument is kept in the signature for
    API stability but no longer narrows the query — calendar reads pull
    the entire org's booked jobs. Override the search-wide pull with
    JOBNIMBUS_DISABLE_CALENDAR_READS=true if you want forced-mock mode.

    Known limitation: Noland's reps do NOT populate date_start on most
    job records (probed 50/50 had date_start=0). This filter will return
    zero results for the foreseeable future, and check_availability will
    fall back to mock-friction calendar. That's intentional — once the
    office starts using JN's calendar OR we wire Google Calendar, this
    same function lights up real availability without code changes."""
    import urllib.parse as _urlparse

    must: list[dict[str, Any]] = [
        {
            "range": {
                "date_start": {"gte": start_unix, "lte": end_unix},
            }
        },
    ]
    # Office argument intentionally ignored — see docstring. Logged so
    # the operator can see which office requested availability and
    # correlate against the LK call ID.
    filter_json = json.dumps({"must": must})
    params = {
        "filter": filter_json,
        "size": str(limit),
    }
    qs = _urlparse.urlencode(params)
    path = f"/jobs?{qs}"

    logger.info(
        "jobnimbus search_jobs date_range=[%d, %d] office=%s",
        start_unix,
        end_unix,
        office,
    )
    response = _request("GET", path)
    # JN returns either {"count": N, "results": [...]} or a bare list
    # depending on the endpoint variant. Handle both.
    if isinstance(response, dict):
        results = response.get("results") or response.get("data") or []
    else:
        results = response if isinstance(response, list) else []
    if not isinstance(results, list):
        return []
    return results


def create_contact(
    *,
    first_name: str,
    last_name: str,
    phone: str,
    email: str | None,
    address: str | None,
    source: str = "Voxaris Estimator",
    office: str | None = None,
) -> dict[str, Any]:
    """Create a homeowner contact in JobNimbus.

    Returns the JN response (includes JobNimbus contact_id). On failure
    raises JobNimbusError — caller falls back to MOCK + webhook + log."""
    # Schema discovered from probing Noland's JN (May 2026):
    #   record_type_name on contacts = "Homeowner" (95%) / "Subcontractor"
    #     / "Business". We default to "Homeowner" — Sarah only creates
    #     homeowner contacts.
    #   status_name = "New" (92%) / "Active" (8%). Sarah-created contacts
    #     are brand new leads → "New".
    #   source / source_name — JN accepts both keys; we send `source` and
    #     let JN normalize. Default falls into Noland's "Web Site / SEO"
    #     bucket so Voxaris-sourced leads are attributable in their
    #     dashboards. Override via JOBNIMBUS_SOURCE_NAME env or `source`
    #     arg if the office wants its own attribution string.
    payload: dict[str, Any] = {
        "first_name": first_name,
        "last_name": last_name,
        "mobile_phone": phone,
        "source_name": source,
        "status_name": "New",
        "record_type_name": "Homeowner",
    }
    if email:
        payload["email"] = email
    if address:
        payload["address_line1"] = address
    # sales_rep_name deliberately NOT set here — see the docstring on
    # search_jobs_by_date_range. Noland's real reps own this field
    # (Nathan, Raymond, Gregory…); writing "Sydney ({office})" would
    # corrupt their assignment workflow. Let the office assign manually.

    # Tag the intake team as owners so every new lead surfaces on
    # their JN dashboard + sends an in-app notification. IDs from
    # JOBNIMBUS_NEW_LEAD_OWNER_IDS env (comma-separated). Locked May
    # 2026 for Noland's: Destiny Jones, Steven Olesen, Savannah
    # Huffman, Myiah Ragone.
    _owner_ids_raw = os.environ.get("JOBNIMBUS_NEW_LEAD_OWNER_IDS", "")
    _owner_ids = [s.strip() for s in _owner_ids_raw.split(",") if s.strip()]
    if _owner_ids:
        payload["owners"] = [{"id": oid} for oid in _owner_ids]

    logger.info(
        "jobnimbus create_contact phone_hash=%s office=%s",
        phone[-4:] if phone else None,  # safe last-4; never log full PII
        office,
    )
    return _request("POST", "/contacts", payload)


def create_inspection_job(
    *,
    contact_id: str,
    address: str,
    date_iso: str,
    time_window: str,
    service_type: str,
    notes: str,
    office: str,
) -> dict[str, Any]:
    """Create the inspection job tied to a contact.

    date_iso: YYYY-MM-DD (homeowner's local date)
    time_window: "morning" (9am-12pm) or "afternoon" (1pm-5pm)
    service_type: matches Sydney's allowlist —
        roof_repair | roof_replacement | renovation | storm_damage | other
    """
    # Translate Sydney's time_window into a real start/end datetime
    # at office-local time. Caller uses America/New_York for FL.
    if time_window not in ("morning", "afternoon"):
        time_window = "afternoon"  # safe default
    start_h = 9 if time_window == "morning" else 13
    end_h = 12 if time_window == "morning" else 17

    # Schema from Noland's JN (May 2026): record_type_name on jobs is
    # "Retail" (81%) / "Insurance" (15%) / "New Construction" (4%) —
    # NOT a literal "Job". Storm-damage service maps to "Insurance"
    # (claim work); everything else defaults to "Retail" (residential
    # walk-in). status_name "Appointment Scheduled" matches Noland's
    # pipeline (14% of all jobs sit in that bucket; reps move them
    # forward from there).
    record_type = "Insurance" if service_type == "storm_damage" else "Retail"
    payload = {
        "primary_contact_id": contact_id,
        "record_type_name": record_type,
        "address_line1": address,
        "date_start": f"{date_iso}T{start_h:02d}:00:00",
        "date_end": f"{date_iso}T{end_h:02d}:00:00",
        "type_name": _service_type_to_jn(service_type),
        "description": notes[:2000] if notes else "",
        "status_name": "Appointment Scheduled",
    }
    # sales_rep_name deliberately NOT set — Noland's reps own this
    # field. Office assigns manually after Sarah creates the job.

    logger.info(
        "jobnimbus create_inspection_job contact=%s date=%s window=%s svc=%s",
        contact_id, date_iso, time_window, service_type,
    )
    return _request("POST", "/jobs", payload)


def attach_note(
    *,
    contact_id: str | None,
    job_id: str | None,
    body: str,
    title: str = "Sydney Call Summary",
) -> dict[str, Any]:
    """Attach a Note to a contact or job. JobNimbus 'activities'
    endpoint is the umbrella; type=note creates a note record."""
    payload = {
        "type": "note",
        "title": title,
        "description": body[:5000],
    }
    if contact_id:
        payload["primary"] = {"id": contact_id, "type": "contact"}
    elif job_id:
        payload["primary"] = {"id": job_id, "type": "job"}
    else:
        raise JobNimbusError("attach_note needs contact_id or job_id")
    return _request("POST", "/activities", payload)


def _service_type_to_jn(service_type: str) -> str:
    """Map Sydney's service_type enum to JobNimbus Job 'type_name'.
    JN orgs typically have these configured; defaults are safe."""
    mapping = {
        "roof_repair": "Roof Repair",
        "roof_replacement": "Roof Replacement",
        "renovation": "Renovation",
        "storm_damage": "Storm Damage",
        "other": "Other",
    }
    return mapping.get(service_type, "Other")


# ─── Health check (for /api/_health and ops dashboards) ───────────────


def healthcheck() -> dict[str, Any]:
    """Lightweight ping — fetches the authenticated user's profile.
    Returns {ok: bool, status: str}. Never raises."""
    if not is_enabled():
        return {"ok": False, "status": "JOBNIMBUS_API_KEY not set"}
    try:
        # /users/me is the canonical "am I authed?" endpoint
        _request("GET", "/users/me")
        return {"ok": True, "status": "authenticated"}
    except JobNimbusError as e:
        return {"ok": False, "status": str(e)[:200]}
    except Exception as e:
        return {"ok": False, "status": f"unexpected: {e}"[:200]}
