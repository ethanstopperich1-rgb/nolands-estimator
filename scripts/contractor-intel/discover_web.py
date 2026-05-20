"""Discover contractor websites via Google Places Text Search."""

from __future__ import annotations

import logging
import os
import re
from urllib.parse import urlparse

import httpx

from models import ContractorProspect

log = logging.getLogger("contractor_intel.discover_web")


def _google_api_key() -> str | None:
    return (
        os.environ.get("GOOGLE_SERVER_KEY")
        or os.environ.get("GOOGLE_MAPS_API_KEY")
        or os.environ.get("NEXT_PUBLIC_GOOGLE_MAPS_KEY")
    )


def _normalize_domain(url: str | None) -> str | None:
    if not url:
        return None
    u = url.strip()
    if not u.startswith(("http://", "https://")):
        u = f"https://{u}"
    try:
        host = urlparse(u).netloc.lower()
    except Exception:
        return None
    if host.startswith("www."):
        host = host[4:]
    if not host or "." not in host:
        return None
    skip = (
        "facebook.com",
        "instagram.com",
        "linkedin.com",
        "yelp.com",
        "bbb.org",
        "angi.com",
        "homeadvisor.com",
        "google.com",
        "youtube.com",
    )
    if any(host == s or host.endswith("." + s) for s in skip):
        return None
    return host


def discover_website_places(prospect: ContractorProspect) -> tuple[str | None, str | None]:
    key = _google_api_key()
    if not key:
        log.warning("No Google API key — skip Places lookup for %s", prospect.display_name)
        return None, None

    query = f"{prospect.display_name} roofing {prospect.city or ''} FL".strip()
    url = "https://maps.googleapis.com/maps/api/place/textsearch/json"
    params = {"query": query, "key": key}

    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        log.warning("Places API failed for %s: %s", prospect.display_name, e)
        return None, None

    status = data.get("status")
    if status not in ("OK", "ZERO_RESULTS"):
        log.warning("Places status=%s for %s", status, prospect.display_name)
        return None, None

    for result in data.get("results", [])[:3]:
        place_id = result.get("place_id")
        if not place_id:
            continue
        details = _place_details(place_id, key)
        if not details:
            continue
        site = details.get("website")
        domain = _normalize_domain(site)
        phone = details.get("formatted_phone_number")
        if domain:
            return f"https://{domain}", phone
    return None, None


def _place_details(place_id: str, key: str) -> dict | None:
    url = "https://maps.googleapis.com/maps/api/place/details/json"
    params = {
        "place_id": place_id,
        "fields": "website,name,formatted_phone_number",
        "key": key,
    }
    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        log.warning("Place details failed: %s", e)
        return None
    if data.get("status") != "OK":
        return None
    return data.get("result")


def enrich_websites(
    prospects: list[ContractorProspect],
    *,
    skip_existing: bool = True,
) -> None:
    for p in prospects:
        if skip_existing and p.website:
            continue
        site, phone = discover_website_places(p)
        if site:
            p.website = site
            p.domain = _normalize_domain(site)
            p.enrichment_status = "web_found"
            p.signals["website_source"] = "google_places"
            if phone and not p.phone:
                p.phone = phone
            log.info("Website: %s → %s", p.display_name, site)
