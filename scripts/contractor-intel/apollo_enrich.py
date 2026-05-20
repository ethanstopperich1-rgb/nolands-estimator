"""Enrich contractor prospects with owner/GM emails via Apollo.io API."""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx

from models import ContractorProspect

log = logging.getLogger("contractor_intel.apollo")

APOLLO_BASE = "https://api.apollo.io/api/v1"

# Free search filters — decision-makers at contractor domains.
SEARCH_SENIORITIES = ("owner", "founder", "c_suite", "partner", "vp")
SEARCH_TITLES = (
    "Owner",
    "President",
    "CEO",
    "General Manager",
    "Founder",
    "Managing Partner",
)

TITLE_RANK = (
    ("owner", 100),
    ("president", 90),
    ("ceo", 88),
    ("founder", 85),
    ("general manager", 80),
    ("managing partner", 75),
    ("principal", 70),
    ("partner", 65),
    ("vp", 50),
    ("director", 40),
)

SENIORITY_RANK = {
    "owner": 50,
    "founder": 48,
    "c_suite": 45,
    "partner": 40,
    "vp": 35,
    "director": 25,
    "manager": 15,
}


@dataclass
class ApolloPersonRef:
    apollo_id: str
    domain: str
    first_name: str | None
    last_name: str | None
    title: str | None
    seniority: str | None


def apollo_api_key() -> str | None:
    return os.environ.get("APOLLO_API_KEY") or os.environ.get("APOLLO_MASTER_API_KEY")


def _headers() -> dict[str, str]:
    key = apollo_api_key()
    if not key:
        raise RuntimeError(
            "APOLLO_API_KEY is not set. Add a master API key to .env.local — "
            "https://app.apollo.io/#/settings/integrations/api"
        )
    return {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "x-api-key": key,
    }


def _domain_for_prospect(p: ContractorProspect) -> str | None:
    if p.domain:
        return p.domain.lower().removeprefix("www.")
    if p.website:
        host = urlparse(p.website).netloc.lower()
        if host.startswith("www."):
            host = host[4:]
        return host or None
    return None


def _org_name_for_prospect(p: ContractorProspect) -> str:
    dba = (p.dba_name or "").strip()
    if dba and "," not in dba:
        return dba
    return p.display_name


def _title_score(title: str | None, seniority: str | None) -> int:
    score = SENIORITY_RANK.get((seniority or "").lower(), 0)
    t = (title or "").lower()
    for needle, pts in TITLE_RANK:
        if needle in t:
            score += pts
            break
    return score


def _pick_best_per_domain(people: list[dict[str, Any]]) -> dict[str, ApolloPersonRef]:
    by_domain: dict[str, tuple[int, ApolloPersonRef]] = {}
    for person in people:
        org = person.get("organization") or {}
        domain = (org.get("primary_domain") or "").lower().strip()
        if not domain:
            continue
        pid = person.get("id") or person.get("person_id")
        if not pid:
            continue
        ref = ApolloPersonRef(
            apollo_id=str(pid),
            domain=domain,
            first_name=person.get("first_name"),
            last_name=person.get("last_name"),
            title=person.get("title"),
            seniority=person.get("seniority"),
        )
        rank = _title_score(ref.title, ref.seniority)
        prev = by_domain.get(domain)
        if prev is None or rank > prev[0]:
            by_domain[domain] = (rank, ref)
    return {d: ref for d, (_, ref) in by_domain.items()}


def search_decision_makers(
    domains: list[str],
    *,
    client: httpx.Client | None = None,
) -> dict[str, ApolloPersonRef]:
    """People API Search (no credits) — map domain → best decision-maker ref."""
    if not domains:
        return {}

    own_client = client is None
    if own_client:
        client = httpx.Client(timeout=60.0)

    found: dict[str, ApolloPersonRef] = {}
    chunk_size = 40  # stay under Apollo limits; easier to debug
    try:
        for i in range(0, len(domains), chunk_size):
            chunk = domains[i : i + chunk_size]
            params: list[tuple[str, str]] = [("per_page", "100"), ("page", "1")]
            for d in chunk:
                params.append(("q_organization_domains_list[]", d))
            for s in SEARCH_SENIORITIES:
                params.append(("person_seniorities[]", s))
            for t in SEARCH_TITLES:
                params.append(("person_titles[]", t))
            params.append(("include_similar_titles", "true"))

            resp = client.post(  # type: ignore[union-attr]
                f"{APOLLO_BASE}/mixed_people/api_search",
                headers=_headers(),
                params=params,
            )
            if resp.status_code == 403:
                log.error(
                    "Apollo search forbidden — use a master API key with search access"
                )
                break
            resp.raise_for_status()
            data = resp.json()
            people = data.get("people") or []
            found.update(_pick_best_per_domain(people))
            log.info(
                "Apollo search chunk %d: %d people, %d domains mapped",
                i // chunk_size + 1,
                len(people),
                len(found),
            )
            time.sleep(0.35)
    finally:
        if own_client and client:
            client.close()

    return found


def _email_confidence(status: str | None) -> str:
    s = (status or "").lower()
    if s == "verified":
        return "high"
    if s in ("likely to engage", "guessed", "unverified"):
        return "medium"
    return "low"


def bulk_match_people(
    refs: list[ApolloPersonRef],
    *,
    client: httpx.Client | None = None,
) -> dict[str, dict[str, Any]]:
    """Bulk People Match — consumes credits; returns domain → enriched person dict."""
    if not refs:
        return {}

    own_client = client is None
    if own_client:
        client = httpx.Client(timeout=90.0)

    enriched: dict[str, dict[str, Any]] = {}
    try:
        for i in range(0, len(refs), 10):
            batch = refs[i : i + 10]
            details = [{"id": r.apollo_id} for r in batch]
            resp = client.post(  # type: ignore[union-attr]
                f"{APOLLO_BASE}/people/bulk_match",
                headers=_headers(),
                params={
                    "reveal_personal_emails": "false",
                    "reveal_phone_number": "false",
                },
                json={"details": details},
            )
            if resp.status_code == 422:
                log.warning("Apollo bulk_match batch skipped: %s", resp.text[:200])
                continue
            resp.raise_for_status()
            data = resp.json()
            for item in data.get("matches") or []:
                person = item.get("person") or {}
                if not person:
                    continue
                org = person.get("organization") or {}
                domain = (org.get("primary_domain") or "").lower().strip()
                if not domain:
                    # fallback: match batch by id
                    pid = person.get("id")
                    for r in batch:
                        if r.apollo_id == pid:
                            domain = r.domain
                            break
                if domain:
                    enriched[domain] = person
            log.info(
                "Apollo bulk_match batch %d: %d matches",
                i // 10 + 1,
                len(data.get("matches") or []),
            )
            time.sleep(0.5)
    finally:
        if own_client and client:
            client.close()

    return enriched


def _apply_person(p: ContractorProspect, person: dict[str, Any], *, source: str) -> None:
    email = (person.get("email") or "").strip().lower()
    if not email:
        p.signals["apollo"] = {source: source, "status": "no_email"}
        return

    p.email = email
    p.email_confidence = _email_confidence(person.get("email_status"))
    p.contact_first_name = person.get("first_name") or p.contact_first_name
    p.contact_last_name = person.get("last_name") or p.contact_last_name
    p.contact_title = person.get("title") or p.contact_title
    if person.get("sanitized_phone") or person.get("phone_numbers"):
        phones = person.get("phone_numbers") or []
        if phones and isinstance(phones[0], dict):
            raw = phones[0].get("sanitized_number") or phones[0].get("raw_number")
            if raw:
                p.phone = raw
        elif person.get("sanitized_phone"):
            p.phone = person["sanitized_phone"]
    p.enrichment_status = "enriched"
    p.signals["apollo"] = {
        "source": source,
        "apollo_id": person.get("id"),
        "email_status": person.get("email_status"),
        "linkedin_url": person.get("linkedin_url"),
    }
    log.info(
        "Apollo: %s → %s (%s, %s)",
        p.display_name,
        p.email,
        p.email_confidence,
        p.contact_title or "—",
    )


def enrich_with_apollo(
    prospects: list[ContractorProspect],
    *,
    limit: int | None = None,
    on_progress: Callable[[], None] | None = None,
    skip_if_email: bool = True,
) -> None:
    """
    For prospects with a domain: Apollo search (free) + bulk_match (credits).
    """
    if not apollo_api_key():
        raise RuntimeError("APOLLO_API_KEY not configured")

    to_process = [p for p in prospects if _domain_for_prospect(p)]
    if limit:
        to_process = to_process[:limit]

    domain_to_prospect: dict[str, ContractorProspect] = {}
    for p in to_process:
        d = _domain_for_prospect(p)
        if d:
            p.domain = d
            domain_to_prospect[d] = p

    domains = list(domain_to_prospect.keys())
    log.info("Apollo enrich: %d domains", len(domains))

    with httpx.Client(timeout=90.0) as client:
        refs_by_domain = search_decision_makers(domains, client=client)
        if not refs_by_domain:
            log.warning("Apollo search returned no decision-makers")
            return

        refs = list(refs_by_domain.values())
        enriched = bulk_match_people(refs, client=client)

    for domain, person in enriched.items():
        p = domain_to_prospect.get(domain)
        if not p:
            continue
        if skip_if_email and p.email and p.email_confidence == "high":
            continue
        _apply_person(p, person, source="bulk_match")
        if on_progress:
            on_progress()

    # Domains with search hit but no email from bulk_match — try domain-only match
    for domain, ref in refs_by_domain.items():
        p = domain_to_prospect.get(domain)
        if not p or p.email:
            continue
        try:
            with httpx.Client(timeout=45.0) as client:
                resp = client.post(
                    f"{APOLLO_BASE}/people/match",
                    headers=_headers(),
                    params={
                        "domain": domain,
                        "organization_name": _org_name_for_prospect(p),
                        "reveal_personal_emails": "false",
                        "reveal_phone_number": "false",
                    },
                )
            if resp.status_code == 200:
                person = resp.json().get("person") or {}
                if person.get("email"):
                    _apply_person(p, person, source="domain_match")
                    if on_progress:
                        on_progress()
        except Exception as e:
            log.debug("Apollo domain match failed %s: %s", domain, e)
        time.sleep(0.35)
