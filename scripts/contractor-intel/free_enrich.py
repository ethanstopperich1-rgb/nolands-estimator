"""Free contact enrichment: site emails → Hunter pattern → construct → verify."""

from __future__ import annotations

import logging
import re
import time
from collections.abc import Callable
from urllib.parse import urlparse

import httpx

from config import FAST_SCRAPE_PATHS, ROLE_EMAIL_LOCALS
from email_validate import validate_email
from hunter_client import (
    domain_search,
    email_finder,
    hunter_api_key,
    verify_email_hunter,
)
from models import ContractorProspect
from name_parse import parse_owner_name
from pattern_email import STANDARD_PATTERNS, build_candidates, infer_pattern_from_email
from scrape_contacts import scrape_domain
from smtp_verify import verify_smtp

log = logging.getLogger("contractor_intel.free_enrich")


def _domain_for_prospect(p: ContractorProspect) -> str | None:
    if p.domain:
        return p.domain.lower().removeprefix("www.")
    if p.website:
        host = urlparse(p.website).netloc.lower()
        return host[4:] if host.startswith("www.") else host or None
    return None


def _pick_hunter_personal(
    emails: list[dict],
    *,
    first: str | None,
    last: str | None,
) -> tuple[str | None, str]:
    """Prefer owner-matching personal email with Hunter verification valid."""
    best: tuple[str | None, str, int] = (None, "low", -1)

    for row in emails:
        value = (row.get("value") or "").strip().lower()
        if not value or "@" not in value:
            continue
        local = value.split("@")[0]
        if local in ROLE_EMAIL_LOCALS:
            continue

        ver = (row.get("verification") or {}).get("status", "")
        conf_rank = 3 if ver == "valid" else 2 if ver == "accept_all" else 1
        fn = (row.get("first_name") or "").lower()
        ln = (row.get("last_name") or "").lower()
        name_match = 0
        if first and last and fn and ln:
            if fn == first.lower() and ln == last.lower():
                name_match = 10
            elif fn == first.lower() or ln == last.lower():
                name_match = 5

        score = conf_rank + name_match + int(row.get("confidence") or 0) // 20
        if score > best[2]:
            conf = "high" if ver == "valid" and name_match >= 5 else "medium"
            best = (value, conf, score)

    return best[0], best[1]


def _verify_candidate(email: str, *, client: httpx.Client) -> tuple[bool, str]:
    """Hunter verifier if key available, else SMTP RCPT."""
    if not validate_email(email):
        return False, "invalid"

    h_status = verify_email_hunter(email, client=client)
    if h_status == "valid":
        return True, "high"
    if h_status == "accept_all":
        return True, "medium"
    if h_status == "invalid":
        return False, "invalid"

    smtp_status = verify_smtp(email)
    if smtp_status == "valid":
        return True, "high"
    if smtp_status == "accept_all":
        return True, "medium"
    return False, "unknown"


def enrich_free(
    prospects: list[ContractorProspect],
    *,
    limit: int | None = None,
    on_progress: Callable[[], None] | None = None,
    use_hunter: bool = True,
    smtp_verify: bool = True,
    hunter_finder_fallback: bool = True,
) -> None:
    """
    Pattern + verify pipeline (no Apollo credits).

    1. Light site scrape for any @domain emails
    2. Hunter domain-search for pattern + indexed emails (if HUNTER_API_KEY)
    3. Infer pattern; build owner candidates from DBPR licensee name
    4. Verify via Hunter email-verifier or SMTP (mailtester-style)
  """
    to_process = [p for p in prospects if _domain_for_prospect(p)]
    if limit:
        to_process = to_process[:limit]

    log.info(
        "Free enrich: %d prospects (hunter=%s, smtp=%s)",
        len(to_process),
        use_hunter and bool(hunter_api_key()),
        smtp_verify,
    )

    with httpx.Client(timeout=30.0) as client:
        for p in to_process:
            domain = _domain_for_prospect(p)
            if not domain:
                continue
            p.domain = domain
            first, last = parse_owner_name(p.licensee_name or p.dba_name)

            # 1) Quick scrape — homepage + contact paths
            scrape = scrape_domain(domain, scrape_paths=FAST_SCRAPE_PATHS)
            site_emails: list[str] = []
            if scrape.contact and scrape.contact.email:
                site_emails.append(scrape.contact.email.lower())
            for m in re.findall(
                rf"[a-z0-9._%+\-]+@{re.escape(domain)}",
                scrape.page_text.lower(),
            ):
                site_emails.append(m)

            pattern: str | None = None
            hunter_data = None
            if use_hunter and hunter_api_key():
                hunter_data = domain_search(domain, client=client)
                if hunter_data:
                    pattern = hunter_data.pattern
                    p.signals["hunter"] = {
                        "pattern": pattern,
                        "accept_all": hunter_data.accept_all,
                    }
                    email, conf = _pick_hunter_personal(
                        hunter_data.emails, first=first, last=last
                    )
                    if email:
                        p.email = email
                        p.email_confidence = conf
                        p.enrichment_status = "enriched"
                        p.signals["free_enrich"] = "hunter_indexed"
                        log.info("Hunter indexed: %s → %s", p.display_name, email)
                        if on_progress:
                            on_progress()
                        continue

            # Infer pattern from site + hunter
            for em in site_emails:
                inferred = infer_pattern_from_email(em, first=first, last=last)
                if inferred:
                    pattern = inferred
                    break
                local = em.split("@")[0]
                if local not in ROLE_EMAIL_LOCALS and "." in local:
                    pattern = "{first}.{last}"
                    break

            if not pattern:
                pattern = "{first}"

            p.signals["email_pattern"] = pattern

            if not first or not last:
                log.info("No parseable owner name for %s — skip pattern", p.display_name)
                if on_progress:
                    on_progress()
                time.sleep(0.5)
                continue

            patterns = [pattern] + [x for x in STANDARD_PATTERNS if x != pattern]
            candidates = build_candidates(
                first=first, last=last, domain=domain, patterns=patterns
            )

            # Named email on site that matches owner
            for em in site_emails:
                inf = infer_pattern_from_email(em, first=first, last=last)
                if inf:
                    ok, conf = _verify_candidate(em, client=client)
                    if ok:
                        p.email = em
                        p.email_confidence = conf
                        p.contact_first_name = first
                        p.contact_last_name = last
                        p.enrichment_status = "enriched"
                        p.signals["free_enrich"] = "site_named_verified"
                        log.info("Site+verify: %s → %s", p.display_name, em)
                        break

            if p.email:
                if on_progress:
                    on_progress()
                time.sleep(0.5)
                continue

            # Verify constructed candidates
            verified_email: str | None = None
            verified_conf = "medium"

            if smtp_verify:
                for cand in candidates:
                    ok, conf = _verify_candidate(cand, client=client)
                    time.sleep(0.5)
                    if ok:
                        verified_email = cand
                        verified_conf = conf
                        break
            else:
                verified_email = candidates[0] if candidates else None

            if verified_email:
                p.email = verified_email
                p.email_confidence = verified_conf
                p.contact_first_name = first
                p.contact_last_name = last
                p.enrichment_status = "enriched"
                p.signals["free_enrich"] = "pattern_verified"
                log.info(
                    "Pattern+verify: %s → %s (%s)",
                    p.display_name,
                    verified_email,
                    pattern,
                )
            elif (
                hunter_finder_fallback
                and use_hunter
                and hunter_api_key()
                and first
                and last
            ):
                found = email_finder(
                    domain=domain,
                    first_name=first,
                    last_name=last,
                    client=client,
                )
                if found:
                    p.email = found.lower()
                    p.email_confidence = "medium"
                    p.contact_first_name = first
                    p.contact_last_name = last
                    p.enrichment_status = "enriched"
                    p.signals["free_enrich"] = "hunter_finder"
                    log.info("Hunter finder: %s → %s", p.display_name, found)

            if on_progress:
                on_progress()
            time.sleep(0.75)
