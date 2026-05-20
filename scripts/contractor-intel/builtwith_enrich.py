"""Detect contractor website tech stack via BuiltWith Domain API (v22)."""

from __future__ import annotations

import logging
import os
import re
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlparse

import httpx

from config import BUILTWITH_TECH_ALIASES, STACK_KEYWORDS
from models import ContractorProspect

log = logging.getLogger("contractor_intel.builtwith")

DOMAIN_API = "https://api.builtwith.com/v22/api.json"
FREE_API = "https://api.builtwith.com/free1/api.json"
BATCH_SIZE = 16  # per WhoAmI / BuiltWith docs


def builtwith_api_key() -> str | None:
    return os.environ.get("BUILTWITH_API_KEY") or os.environ.get("BUILTWITH_KEY")


def _domain_for_prospect(p: ContractorProspect) -> str | None:
    if p.domain:
        return p.domain.lower().removeprefix("www.")
    if p.website:
        host = urlparse(p.website).netloc.lower()
        return host[4:] if host.startswith("www.") else host or None
    return None


def _normalize_tech_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", name.lower())


def _match_stack_keywords(tech_names: list[str]) -> list[str]:
    """Map BuiltWith technology names → STACK_KEYWORDS hits."""
    hits: list[str] = []
    blob = " ".join(tech_names).lower()
    for kw in STACK_KEYWORDS:
        if kw in blob and kw not in hits:
            hits.append(kw)
    for tech in tech_names:
        norm = _normalize_tech_name(tech)
        alias = BUILTWITH_TECH_ALIASES.get(norm)
        if alias and alias not in hits:
            hits.append(alias)
        for kw in STACK_KEYWORDS:
            if kw in norm and kw not in hits:
                hits.append(kw)
    return hits


def _extract_technologies(result_block: dict[str, Any]) -> list[str]:
    names: list[str] = []
    for path in result_block.get("Paths") or []:
        for tech in path.get("Technologies") or []:
            name = (tech.get("Name") or "").strip()
            if name:
                names.append(name)
    # dedupe preserve order
    seen: set[str] = set()
    out: list[str] = []
    for n in names:
        key = n.lower()
        if key not in seen:
            seen.add(key)
            out.append(n)
    return out


def _parse_domain_response(data: dict[str, Any]) -> dict[str, list[str]]:
    by_domain: dict[str, list[str]] = {}
    for item in data.get("Results") or []:
        lookup = (item.get("Lookup") or "").lower().strip()
        result = item.get("Result") or {}
        if lookup:
            by_domain[lookup] = _extract_technologies(result)
        meta = item.get("Meta") or {}
        if lookup and meta.get("CompanyName"):
            pass  # reserved for future personalization
    for err in data.get("Errors") or []:
        log.warning("BuiltWith error: %s", err)
    return by_domain


def _fetch_domain_batch(
    domains: list[str],
    *,
    client: httpx.Client,
    use_free: bool = False,
) -> dict[str, list[str]]:
    key = builtwith_api_key()
    if not key:
        raise RuntimeError(
            "BUILTWITH_API_KEY not set — add to .env.local "
            "(https://api.builtwith.com/)"
        )

    lookup = ",".join(domains)
    url = FREE_API if use_free else DOMAIN_API
    resp = client.get(
        url,
        params={"KEY": key, "LOOKUP": lookup, "LIVEONLY": "yes"},
        timeout=60.0,
    )
    resp.raise_for_status()
    data = resp.json()

    if use_free:
        # Free API: category counts only — limited stack signal
        by_domain: dict[str, list[str]] = {}
        for item in data.get("Results") or []:
            lookup = (item.get("Lookup") or "").lower().strip()
            groups = item.get("Groups") or item.get("Result", {}).get("Groups") or []
            tags = []
            for g in groups:
                if isinstance(g, dict):
                    tags.append(g.get("Name") or g.get("Tag") or "")
                else:
                    tags.append(str(g))
            by_domain[lookup] = [t for t in tags if t]
        return by_domain

    return _parse_domain_response(data)


def enrich_stack_builtwith(
    prospects: list[ContractorProspect],
    *,
    limit: int | None = None,
    on_progress: Callable[[], None] | None = None,
    use_free_tier: bool = False,
) -> None:
    """Attach BuiltWith technologies to prospect signals for ICP scoring."""
    if not builtwith_api_key():
        raise RuntimeError("BUILTWITH_API_KEY not configured")

    domain_map: dict[str, ContractorProspect] = {}
    for p in prospects:
        d = _domain_for_prospect(p)
        if d:
            p.domain = d
            domain_map[d] = p

    domains = list(domain_map.keys())
    if limit:
        domains = domains[:limit]

    log.info(
        "BuiltWith stack lookup: %d domains (%s)",
        len(domains),
        "free1" if use_free_tier else "v22",
    )

    with httpx.Client() as client:
        for i in range(0, len(domains), BATCH_SIZE):
            batch = domains[i : i + BATCH_SIZE]
            try:
                tech_by_domain = _fetch_domain_batch(
                    batch, client=client, use_free=use_free_tier
                )
            except httpx.HTTPStatusError as e:
                log.warning("BuiltWith batch failed: %s", e)
                continue

            for domain, techs in tech_by_domain.items():
                p = domain_map.get(domain)
                if not p:
                    continue
                hits = _match_stack_keywords(techs)
                p.signals["builtwith_techs"] = techs[:50]
                p.signals["builtwith_text"] = " ".join(techs).lower()
                if hits:
                    existing = list(p.signals.get("stack_hits") or [])
                    for h in hits:
                        if h not in existing:
                            existing.append(h)
                    p.signals["stack_hits"] = existing
                log.info(
                    "BuiltWith: %s → %d techs, stack hits: %s",
                    p.display_name,
                    len(techs),
                    hits or "—",
                )
                if on_progress:
                    on_progress()
            time.sleep(0.25)
