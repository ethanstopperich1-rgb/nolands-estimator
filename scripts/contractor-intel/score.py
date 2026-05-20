"""ICP scoring for FL roofing contractor prospects."""

from __future__ import annotations

import logging
import re

from config import NEGATIVE_KEYWORDS, STACK_KEYWORDS
from models import ContractorProspect

log = logging.getLogger("contractor_intel.score")

CONF_RANK = {"high": 3, "medium": 2, "low": 1}


def _has_email(p: ContractorProspect, min_conf: str) -> bool:
    if not p.email:
        return False
    return CONF_RANK.get(p.email_confidence or "low", 0) >= CONF_RANK.get(min_conf, 2)


def score_prospect(p: ContractorProspect, *, min_email_conf: str = "medium") -> float:
    score = 0.0
    signals: dict = dict(p.signals)

    # Active CCC + metro (already filtered — baseline)
    occ = (p.occupation_code or p.class_code or "").upper()
    if occ == "CCC" or p.signals.get("source") == "dbpr":
        score += 25
    if p.metro:
        score += 10

    if _has_email(p, min_email_conf):
        score += 30
    elif p.email:
        score += 10

    title = (p.contact_title or "").lower()
    if any(t in title for t in ("owner", "president", "ceo", "general manager", "gm", "founder")):
        score += 20

    if p.website and p.website.startswith("http"):
        score += 10

    stack_text = " ".join(
        str(signals.get(k, ""))
        for k in ("page_text", "builtwith_text", "stack_hits")
    ).lower()
    if signals.get("builtwith_techs"):
        stack_text += " " + " ".join(signals["builtwith_techs"]).lower()
    if not stack_text and signals.get("scrape"):
        stack_text = str(signals.get("scrape", ""))

    stack_hits: list[str] = []
    for kw, pts in STACK_KEYWORDS.items():
        if kw in stack_text:
            score += pts
            stack_hits.append(kw)
    if stack_hits:
        signals["stack_hits"] = stack_hits

    for kw, pts in NEGATIVE_KEYWORDS.items():
        if kw in stack_text:
            score += pts
            signals.setdefault("penalties", []).append(kw)

    # Company-size proxies (soft — DBPR has no headcount)
    if re.search(r"\b(careers|join our team|we're hiring|now hiring)\b", stack_text):
        score += 8
        signals["has_careers_page"] = True
    if re.search(r"\b(locations|service area|serving .{3,30} counties)\b", stack_text):
        score += 10
        signals["multi_location_hint"] = True
    if re.search(r"\b(gaf master|owens corning preferred|certified installer)\b", stack_text):
        score += 5
        signals["manufacturer_cert_hint"] = True

    # Sole-prop heuristic
    dba = (p.dba_name or "").strip()
    licensee = (p.licensee_name or "").strip()
    if not dba and licensee and "," not in licensee:
        if re.match(r"^[A-Z][a-z]+ [A-Z][a-z]+$", licensee):
            score -= 12
            signals["sole_prop_hint"] = True

    p.lead_score = round(max(0.0, min(100.0, score)), 2)
    p.signals = signals

    if _has_email(p, min_email_conf) and p.lead_score >= 55:
        p.enrichment_status = "export_ready"
    elif p.email:
        p.enrichment_status = "enriched"

    return p.lead_score


def rank_prospects(
    prospects: list[ContractorProspect],
    *,
    top_n: int = 200,
    min_score: float = 55.0,
    min_email_conf: str = "medium",
) -> list[ContractorProspect]:
    for p in prospects:
        if p.exclude_reason:
            continue
        score_prospect(p, min_email_conf=min_email_conf)

    eligible = [
        p
        for p in prospects
        if not p.exclude_reason
        and _has_email(p, min_email_conf)
        and p.lead_score >= min_score
    ]
    eligible.sort(key=lambda x: (-x.lead_score, x.display_name))
    ranked = eligible[:top_n]
    log.info(
        "Ranked %d export-ready from %d prospects (top_n=%d, min_score=%s)",
        len(ranked),
        len(prospects),
        top_n,
        min_score,
    )
    return ranked
