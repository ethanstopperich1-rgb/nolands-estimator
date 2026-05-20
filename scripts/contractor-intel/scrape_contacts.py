"""Scrape contractor websites for owner/GM emails and phones."""

from __future__ import annotations

import logging
from collections.abc import Callable
import random
import re
import time
import urllib.robotparser
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from browser import browser_session, fetch_page_html
from config import (
    DECISION_TITLE_RE,
    FAST_SCRAPE_PATHS,
    GENERIC_EMAIL_LOCALS,
    RATE_LIMIT_MAX_SEC,
    RATE_LIMIT_MIN_SEC,
    ROLE_EMAIL_LOCALS,
    SCRAPE_PATHS,
    USER_AGENT,
)
from email_validate import validate_email
from models import ContractorProspect

log = logging.getLogger("contractor_intel.scrape_contacts")

EMAIL_RE = re.compile(
    r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}",
    re.IGNORECASE,
)
PHONE_RE = re.compile(r"\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})")


@dataclass
class ContactHit:
    email: str
    confidence: str
    first_name: str | None = None
    last_name: str | None = None
    title: str | None = None
    phone: str | None = None
    source_url: str | None = None


@dataclass
class ScrapeResult:
    contact: ContactHit | None
    page_text: str


def _sleep() -> None:
    time.sleep(random.uniform(RATE_LIMIT_MIN_SEC, RATE_LIMIT_MAX_SEC))


def _robots_allows(domain: str, path: str) -> bool:
    robots_url = f"https://{domain}/robots.txt"
    try:
        rp = urllib.robotparser.RobotFileParser()
        rp.set_url(robots_url)
        rp.read()
        return rp.can_fetch(USER_AGENT, f"https://{domain}{path}")
    except Exception:
        return True


def _fetch_httpx(url: str) -> str | None:
    try:
        with httpx.Client(
            timeout=25.0,
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT},
        ) as client:
            resp = client.get(url)
            if resp.status_code >= 400:
                return None
            return resp.text
    except Exception as e:
        log.debug("httpx fetch failed %s: %s", url, e)
        return None


def _extract_emails(html: str, domain: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    found: set[str] = set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if href.startswith("mailto:"):
            found.add(href[7:].split("?")[0].strip().lower())
    text = soup.get_text(" ", strip=True)
    for m in EMAIL_RE.findall(text):
        found.add(m.lower())
    return [e for e in found if e.endswith(f"@{domain}") or f"@{domain}" in e]


def _classify_email(local: str, *, named_person: bool) -> str:
    local_l = local.lower()
    if local_l in GENERIC_EMAIL_LOCALS:
        return "low"
    if named_person:
        return "high"
    if local_l in ROLE_EMAIL_LOCALS:
        return "medium"
    if "." in local_l and len(local_l) > 3:
        return "high"
    return "medium"


def _parse_people_blocks(soup: BeautifulSoup, domain: str) -> list[ContactHit]:
    hits: list[ContactHit] = []
    blocks = soup.find_all(["div", "li", "article", "section", "p"])
    for block in blocks[:400]:
        text = block.get_text(" ", strip=True)
        if not text or len(text) > 500:
            continue
        if not re.search(DECISION_TITLE_RE, text):
            continue
        emails = EMAIL_RE.findall(str(block))
        emails = [e.lower() for e in emails if domain in e.lower()]
        if not emails:
            continue
        title_m = re.search(DECISION_TITLE_RE, text)
        title = title_m.group(0) if title_m else None
        name_m = re.match(
            r"^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+[-–,]?\s*",
            text[:80],
        )
        first, last = None, None
        if name_m:
            parts = name_m.group(1).split()
            first = parts[0]
            last = parts[-1] if len(parts) > 1 else None
        email = emails[0]
        local = email.split("@")[0]
        conf = _classify_email(local, named_person=bool(first))
        hits.append(
            ContactHit(
                email=email,
                confidence=conf,
                first_name=first,
                last_name=last,
                title=title,
                source_url=None,
            )
        )
    return hits


def _best_phone(text: str) -> str | None:
    for m in PHONE_RE.finditer(text):
        area, exch, num = m.groups()
        if area.startswith(("0", "1")):
            continue
        return f"+1{area}{exch}{num}"
    return None


def scrape_domain(
    domain: str,
    *,
    use_browser: bool = False,
    page=None,
    scrape_paths: tuple[str, ...] | None = None,
) -> ScrapeResult:
    """Crawl standard paths; return best contact hit + combined page text for scoring."""
    best: ContactHit | None = None
    rank = {"high": 3, "medium": 2, "low": 1}
    text_chunks: list[str] = []
    paths = scrape_paths or SCRAPE_PATHS

    for path in paths:
        if not _robots_allows(domain, path):
            continue
        url = f"https://{domain}{path}"
        html: str | None = None
        if use_browser and page is not None:
            try:
                html = fetch_page_html(page, url, settle_ms=1200)
            except Exception as e:
                log.debug("browser scrape failed %s: %s", url, e)
        else:
            html = _fetch_httpx(url)
            if html is None and page is not None:
                try:
                    html = fetch_page_html(page, url, settle_ms=1200)
                except Exception:
                    pass

        if not html:
            continue

        soup = BeautifulSoup(html, "html.parser")
        text_chunks.append(soup.get_text(" ", strip=True)[:12_000])
        people = _parse_people_blocks(soup, domain)
        emails = _extract_emails(html, domain)

        candidates: list[ContactHit] = list(people)
        for email in emails:
            local = email.split("@")[0]
            candidates.append(
                ContactHit(
                    email=email,
                    confidence=_classify_email(local, named_person=False),
                    source_url=url,
                )
            )

        phone = _best_phone(soup.get_text(" ", strip=True)[:8000])

        for c in candidates:
            if not validate_email(c.email):
                continue
            if phone and not c.phone:
                c.phone = phone
            c.source_url = url
            if best is None or rank.get(c.confidence, 0) > rank.get(best.confidence, 0):
                best = c

        _sleep()

    page_text = " ".join(text_chunks)[:20_000]
    return ScrapeResult(contact=best, page_text=page_text)


def enrich_contacts(
    prospects: list[ContractorProspect],
    *,
    limit: int | None = None,
    force_browser: bool = False,
    fast: bool = False,
    on_progress: Callable[[], None] | None = None,
) -> None:
    """Enrich prospects that have domains. Uses CloakBrowser when httpx fails."""
    to_process = [p for p in prospects if p.domain or p.website]
    if limit:
        to_process = to_process[:limit]

    browser_needed = force_browser
    if not browser_needed:
        # Sample first 3 with httpx-only probe
        for p in to_process[:3]:
            d = p.domain or urlparse(p.website or "").netloc
            if d and _fetch_httpx(f"https://{d}/") is None:
                browser_needed = True
                break

    scrape_paths = FAST_SCRAPE_PATHS if fast else SCRAPE_PATHS

    def _run_batch(batch: list[ContractorProspect], page=None) -> None:
        for p in batch:
            domain = p.domain
            if not domain and p.website:
                domain = urlparse(p.website).netloc.lower().removeprefix("www.")
            if not domain:
                continue
            p.domain = domain
            result = scrape_domain(
                domain,
                use_browser=page is not None,
                page=page,
                scrape_paths=scrape_paths,
            )
            p.last_scraped_at = datetime.now(timezone.utc)
            if result.page_text:
                p.signals["page_text"] = result.page_text
            hit = result.contact
            if not hit:
                p.signals["scrape"] = "no_contact"
                if on_progress:
                    on_progress()
                continue
            p.email = hit.email
            p.email_confidence = hit.confidence
            p.contact_first_name = hit.first_name
            p.contact_last_name = hit.last_name
            p.contact_title = hit.title
            if hit.phone:
                p.phone = hit.phone
            p.enrichment_status = "enriched"
            p.signals["scrape"] = {
                "source_url": hit.source_url,
                "confidence": hit.confidence,
            }
            log.info(
                "Contact: %s → %s (%s)",
                p.display_name,
                hit.email,
                hit.confidence,
            )
            if on_progress:
                on_progress()

    if browser_needed:
        with browser_session() as page:
            _run_batch(to_process, page)
    else:
        _run_batch(to_process, None)
