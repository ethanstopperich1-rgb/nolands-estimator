"""Hunter.io API — domain pattern, indexed emails, verification."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

import httpx

log = logging.getLogger("contractor_intel.hunter")

HUNTER_BASE = "https://api.hunter.io/v2"


def hunter_api_key() -> str | None:
    return os.environ.get("HUNTER_API_KEY") or os.environ.get("HUNTER_KEY")


@dataclass
class HunterDomainResult:
    pattern: str | None
    accept_all: bool
    emails: list[dict[str, Any]]


def domain_search(domain: str, *, client: httpx.Client | None = None) -> HunterDomainResult | None:
    key = hunter_api_key()
    if not key:
        return None

    own = client is None
    if own:
        client = httpx.Client(timeout=30.0)
    try:
        resp = client.get(  # type: ignore[union-attr]
            f"{HUNTER_BASE}/domain-search",
            params={
                "domain": domain,
                "api_key": key,
                "limit": 10,
                "type": "personal",
            },
        )
        if resp.status_code == 401:
            log.error("Hunter API key invalid")
            return None
        if resp.status_code == 429:
            log.warning("Hunter rate limit — skip domain %s", domain)
            return None
        resp.raise_for_status()
        data = resp.json().get("data") or {}
        return HunterDomainResult(
            pattern=data.get("pattern"),
            accept_all=bool(data.get("accept_all")),
            emails=list(data.get("emails") or []),
        )
    except Exception as e:
        log.warning("Hunter domain-search %s: %s", domain, e)
        return None
    finally:
        if own and client:
            client.close()


def verify_email_hunter(email: str, *, client: httpx.Client | None = None) -> str | None:
    """Returns Hunter status: valid, accept_all, invalid, unknown, or None if no key."""
    key = hunter_api_key()
    if not key:
        return None

    own = client is None
    if own:
        client = httpx.Client(timeout=30.0)
    try:
        resp = client.get(  # type: ignore[union-attr]
            f"{HUNTER_BASE}/email-verifier",
            params={"email": email, "api_key": key},
        )
        if resp.status_code != 200:
            return None
        status = (resp.json().get("data") or {}).get("status")
        return str(status) if status else None
    except Exception as e:
        log.debug("Hunter verify %s: %s", email, e)
        return None
    finally:
        if own and client:
            client.close()


def email_finder(
    *,
    domain: str,
    first_name: str,
    last_name: str,
    client: httpx.Client | None = None,
) -> str | None:
    """Uses 1 Hunter credit — last resort after pattern guesses."""
    key = hunter_api_key()
    if not key:
        return None

    own = client is None
    if own:
        client = httpx.Client(timeout=30.0)
    try:
        resp = client.get(  # type: ignore[union-attr]
            f"{HUNTER_BASE}/email-finder",
            params={
                "domain": domain,
                "first_name": first_name,
                "last_name": last_name,
                "api_key": key,
            },
        )
        if resp.status_code != 200:
            return None
        return (resp.json().get("data") or {}).get("email")
    except Exception as e:
        log.debug("Hunter email-finder %s: %s", domain, e)
        return None
    finally:
        if own and client:
            client.close()
