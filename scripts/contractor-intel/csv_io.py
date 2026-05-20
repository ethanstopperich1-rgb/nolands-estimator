"""CSV read/write — primary deliverable for the contractor intel pipeline."""

from __future__ import annotations

import csv
import json
import logging
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path

from config import DATA_DIR, DEMO_URL, OUTPUT_DIR
from models import ContractorProspect

log = logging.getLogger("contractor_intel.csv_io")

# Flat spreadsheet: every field you might filter/sort in Excel or Google Sheets.
MASTER_FIELDS = [
    "license_number",
    "company_name",
    "licensee_name",
    "dba_name",
    "occupation_code",
    "city",
    "state",
    "zip",
    "county_name",
    "metro",
    "address_line1",
    "address_line2",
    "website",
    "domain",
    "email",
    "email_confidence",
    "contact_first_name",
    "contact_last_name",
    "contact_title",
    "phone",
    "lead_score",
    "enrichment_status",
    "exclude_reason",
    "license_status",
    "personalization_hook",
    "demo_url",
]

SEED_FIELDS = [
    "license_number",
    "company_name",
    "licensee_name",
    "dba_name",
    "occupation_code",
    "city",
    "state",
    "zip",
    "county_name",
    "county_code",
    "metro",
    "address_line1",
    "license_status",
]

INSTANTLY_FIELDS = [
    "email",
    "first_name",
    "last_name",
    "company_name",
    "website",
    "phone",
    "job_title",
    "location",
    "personalization_hook",
    "demo_url",
    "lead_score",
    "metro",
    "license_number",
]

REVIEW_EXTRA = [
    "email_confidence",
    "domain",
    "county",
    "enrichment_status",
    "lead_score",
    "signals_json",
]


@dataclass
class CsvOutputs:
    stamp: str
    seed: Path
    master: Path
    master_latest: Path
    instantly: Path
    instantly_latest: Path
    review: Path


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d")


def _personalization_hook(p: ContractorProspect) -> str:
    city = (p.city or "Florida").title()
    return (
        f"Saw {p.display_name} serving {city} — we turn roofing sites into a 24/7 "
        f"appointment machine on your brand (Estimator wedge, 30-sec demo)."
    )


def _fmt_val(val: object) -> str:
    if val is None:
        return ""
    if isinstance(val, (datetime, date)):
        return val.isoformat()
    if isinstance(val, float):
        return f"{val:.2f}".rstrip("0").rstrip(".")
    return str(val)


def prospect_to_master_row(p: ContractorProspect) -> dict[str, str]:
    return {
        "license_number": p.license_number,
        "company_name": p.display_name,
        "licensee_name": p.licensee_name or "",
        "dba_name": p.dba_name or "",
        "occupation_code": p.occupation_code or "",
        "city": p.city or "",
        "state": p.state or "FL",
        "zip": p.zip or "",
        "county_name": p.county_name or "",
        "metro": p.metro or "",
        "address_line1": p.address_line1 or "",
        "address_line2": p.address_line2 or "",
        "website": p.website or "",
        "domain": p.domain or "",
        "email": (p.email or "").strip().lower(),
        "email_confidence": p.email_confidence or "",
        "contact_first_name": p.contact_first_name or "",
        "contact_last_name": p.contact_last_name or "",
        "contact_title": p.contact_title or "",
        "phone": p.phone or "",
        "lead_score": _fmt_val(p.lead_score),
        "enrichment_status": p.enrichment_status,
        "exclude_reason": p.exclude_reason or "",
        "license_status": p.license_status or "",
        "personalization_hook": _personalization_hook(p),
        "demo_url": DEMO_URL,
    }


def prospect_to_instantly_row(p: ContractorProspect) -> dict[str, str]:
    first = (p.contact_first_name or "").strip() or "there"
    city = (p.city or "").title()
    state = (p.state or "FL").upper()
    location = ", ".join(x for x in [city, state] if x)
    return {
        "email": (p.email or "").strip().lower(),
        "first_name": first,
        "last_name": (p.contact_last_name or "").strip(),
        "company_name": p.display_name,
        "website": p.website or "",
        "phone": p.phone or "",
        "job_title": p.contact_title or "Owner",
        "location": location,
        "personalization_hook": _personalization_hook(p),
        "demo_url": DEMO_URL,
        "lead_score": _fmt_val(p.lead_score),
        "metro": p.metro or "",
        "license_number": p.license_number,
    }


def prospect_to_review_row(p: ContractorProspect) -> dict[str, str]:
    row = prospect_to_instantly_row(p)
    row.update(
        {
            "email_confidence": p.email_confidence or "",
            "domain": p.domain or "",
            "county": p.county_name or "",
            "enrichment_status": p.enrichment_status,
            "signals_json": json.dumps(p.signals, separators=(",", ":")),
        }
    )
    return row


def prospect_to_seed_row(p: ContractorProspect) -> dict[str, str]:
    return {
        "license_number": p.license_number,
        "company_name": p.display_name,
        "licensee_name": p.licensee_name or "",
        "dba_name": p.dba_name or "",
        "occupation_code": p.occupation_code or "",
        "city": p.city or "",
        "state": p.state or "FL",
        "zip": p.zip or "",
        "county_name": p.county_name or "",
        "county_code": p.county_code or "",
        "metro": p.metro or "",
        "address_line1": p.address_line1 or "",
        "license_status": p.license_status or "",
    }


def _write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fieldnames})
    log.info("Wrote %s (%d rows)", path, len(rows))


def _copy_latest(dated: Path, latest: Path) -> None:
    """Overwrite stable `*_latest.csv` so Instantly path never changes."""
    latest.parent.mkdir(parents=True, exist_ok=True)
    latest.write_bytes(dated.read_bytes())
    log.info("Updated %s", latest)


def write_csv_file(
    path: Path,
    prospects: list[ContractorProspect],
    *,
    kind: str = "master",
) -> Path:
    if kind == "seed":
        rows = [prospect_to_seed_row(p) for p in prospects]
        _write_csv(path, SEED_FIELDS, rows)
    elif kind == "instantly":
        rows = [prospect_to_instantly_row(p) for p in prospects]
        _write_csv(path, INSTANTLY_FIELDS, rows)
    elif kind == "review":
        rows = [prospect_to_review_row(p) for p in prospects]
        review_fields = INSTANTLY_FIELDS + [
            "email_confidence",
            "domain",
            "county",
            "enrichment_status",
            "signals_json",
        ]
        _write_csv(path, review_fields, rows)
    else:
        rows = [prospect_to_master_row(p) for p in prospects]
        _write_csv(path, MASTER_FIELDS, rows)
    return path


def write_progress_snapshot(
    prospects: list[ContractorProspect],
    *,
    output_dir: Path | None = None,
    label: str = "in_progress",
) -> Path:
    """Write/update master CSV while the pipeline is still running."""
    out = output_dir or OUTPUT_DIR
    out.mkdir(parents=True, exist_ok=True)
    master_latest = out / "contractor_prospects_latest.csv"
    write_csv_file(master_latest, prospects, kind="master")
    log.info(
        "Progress snapshot (%s): %d rows → %s",
        label,
        len(prospects),
        master_latest,
    )
    return master_latest


def write_pipeline_csvs(
    *,
    seed: list[ContractorProspect],
    all_prospects: list[ContractorProspect],
    ranked: list[ContractorProspect],
    output_dir: Path | None = None,
    stamp: str | None = None,
) -> CsvOutputs:
    """Write all pipeline CSVs under output/ (and stable *_latest.csv copies)."""
    out = output_dir or OUTPUT_DIR
    stamp = stamp or _stamp()

    seed_path = out / f"contractor_seed_{stamp}.csv"
    master_path = out / f"contractor_prospects_{stamp}.csv"
    master_latest = out / "contractor_prospects_latest.csv"
    instantly_path = out / f"instantly_fl_roofing_{stamp}.csv"
    instantly_latest = out / "instantly_fl_roofing_latest.csv"
    review_path = out / f"review_fl_roofing_{stamp}.csv"

    write_csv_file(seed_path, seed, kind="seed")
    write_csv_file(master_path, all_prospects, kind="master")
    _copy_latest(master_path, master_latest)

    if ranked:
        write_csv_file(instantly_path, ranked, kind="instantly")
        _copy_latest(instantly_path, instantly_latest)
        write_csv_file(review_path, ranked, kind="review")
    else:
        log.warning("No ranked export-ready prospects — Instantly CSV not written")
        instantly_path = instantly_latest
        review_path = out / f"review_fl_roofing_{stamp}.csv"

    # Also cache seed in data/ for re-runs without re-downloading DBPR
    seed_cache = DATA_DIR / "seed_latest.csv"
    _copy_latest(seed_path, seed_cache)

    return CsvOutputs(
        stamp=stamp,
        seed=seed_path,
        master=master_path,
        master_latest=master_latest,
        instantly=instantly_path if ranked else instantly_latest,
        instantly_latest=instantly_latest,
        review=review_path,
    )


def load_prospects_from_csv(path: Path) -> list[ContractorProspect]:
    """Load enriched prospects from contractor_prospects_*.csv."""
    prospects: list[ContractorProspect] = []
    with path.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            signals: dict = {}
            raw = row.get("signals_json") or row.get("signals") or ""
            if raw.strip().startswith("{"):
                try:
                    signals = json.loads(raw)
                except json.JSONDecodeError:
                    pass
            metro = row.get("metro", "").strip()
            if metro:
                signals["metro"] = metro
            score_raw = row.get("lead_score", "0") or "0"
            try:
                lead_score = float(score_raw)
            except ValueError:
                lead_score = 0.0
            prospects.append(
                ContractorProspect(
                    license_number=row["license_number"],
                    licensee_name=row.get("licensee_name") or None,
                    dba_name=row.get("dba_name") or row.get("company_name") or None,
                    occupation_code=row.get("occupation_code") or None,
                    city=row.get("city") or None,
                    state=row.get("state") or "FL",
                    zip=row.get("zip") or None,
                    county_name=row.get("county_name") or row.get("county") or None,
                    address_line1=row.get("address_line1") or None,
                    website=row.get("website") or None,
                    domain=row.get("domain") or None,
                    contact_first_name=row.get("contact_first_name") or None,
                    contact_last_name=row.get("contact_last_name") or None,
                    contact_title=row.get("contact_title") or None,
                    email=row.get("email") or None,
                    email_confidence=row.get("email_confidence") or None,
                    phone=row.get("phone") or None,
                    lead_score=lead_score,
                    enrichment_status=row.get("enrichment_status") or "discovered",
                    exclude_reason=row.get("exclude_reason") or None,
                    license_status=row.get("license_status") or None,
                    signals=signals,
                )
            )
    log.info("Loaded %d prospects from %s", len(prospects), path)
    return prospects
