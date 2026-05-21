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
    payload: dict[str, Any] = {
        "first_name": first_name,
        "last_name": last_name,
        "mobile_phone": phone,
        "source": source,
        # JobNimbus expects status_name "Lead" for new lead contacts
        # (vs "Active" for converted customers, "Inactive" for churned).
        "status_name": "Lead",
    }
    if email:
        payload["email"] = email
    if address:
        payload["address_line1"] = address
    if office:
        # Custom field — only present in JN orgs that defined it.
        # Safe to send; ignored when not configured.
        payload["sales_rep_name"] = f"Sydney ({office})"

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

    payload = {
        "primary_contact_id": contact_id,
        "record_type_name": "Job",
        "address_line1": address,
        "date_start": f"{date_iso}T{start_h:02d}:00:00",
        "date_end": f"{date_iso}T{end_h:02d}:00:00",
        "type_name": _service_type_to_jn(service_type),
        "description": notes[:2000] if notes else "",
        "sales_rep_name": f"Sydney ({office})",
        "status_name": "Inspection Scheduled",
    }

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
