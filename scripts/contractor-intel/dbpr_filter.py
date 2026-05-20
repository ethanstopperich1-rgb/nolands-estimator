#!/usr/bin/env python3
"""Filter DBPR rows to active CCC roofing contractors in target FL metros."""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from pathlib import Path

from config import (
    ACTIVE_STATUS_KEYWORDS,
    FL_COUNTY_BY_CODE,
    HILLSBOROUGH_COUNTY_CODES,
    METRO_COUNTIES,
    METRO_COUNTY_DBPR_CODES,
    METRO_CITY_ALIASES,
    ROOFING_OCCUPATION_CODES,
)
from dbpr_fetch import download_dbpr, parse_dbpr_csv
from models import ContractorProspect

log = logging.getLogger("contractor_intel.dbpr_filter")


def _norm(s: str | None) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().upper())


def _county_name(code: str | None) -> str | None:
    if not code:
        return None
    c = code.strip()
    name = FL_COUNTY_BY_CODE.get(c) or FL_COUNTY_BY_CODE.get(c.zfill(3))
    if name:
        return name
    if c.zfill(3) in HILLSBOROUGH_COUNTY_CODES or c in HILLSBOROUGH_COUNTY_CODES:
        return "HILLSBOROUGH"
    return None


def _is_active(status: str | None) -> bool:
    s = _norm(status)
    if not s:
        return False
    return any(k in s for k in ACTIVE_STATUS_KEYWORDS)


def _match_metro(
    city: str | None,
    county_name: str | None,
    county_code: str | None,
    metros: list[str],
) -> str | None:
    city_u = _norm(city)
    county_u = _norm(county_name)
    code = (county_code or "").strip()
    code3 = code.zfill(3) if code.isdigit() else code

    for metro in metros:
        dbpr_codes = METRO_COUNTY_DBPR_CODES.get(metro, frozenset())
        if code in dbpr_codes or code3 in dbpr_codes:
            return metro
        counties = METRO_COUNTIES.get(metro, frozenset())
        if county_u and county_u in counties:
            return metro
        cities = METRO_CITY_ALIASES.get(metro, frozenset())
        if city_u and city_u in cities:
            return metro
    return None


def filter_roofing_prospects(
    rows: list[dict[str, str]],
    *,
    metros: list[str] | None = None,
) -> list[ContractorProspect]:
    metros = metros or list(METRO_COUNTIES.keys())
    out: list[ContractorProspect] = []
    seen_licenses: set[str] = set()

    for row in rows:
        occ = _norm(row.get("occupation_code"))
        if occ not in ROOFING_OCCUPATION_CODES:
            continue
        if not _is_active(row.get("primary_status")):
            continue

        state = _norm(row.get("state"))
        if state and state not in ("FL", "FLORIDA"):
            continue

        county = _county_name(row.get("county_code"))
        metro = _match_metro(row.get("city"), county, row.get("county_code"), metros)
        if not metro:
            continue

        lic = (row.get("license_number") or "").strip()
        if not lic or lic in seen_licenses:
            continue
        seen_licenses.add(lic)

        prospect = ContractorProspect(
            license_number=lic,
            board_number=row.get("board_number"),
            occupation_code=row.get("occupation_code"),
            licensee_name=row.get("licensee_name"),
            dba_name=row.get("dba_name"),
            class_code=row.get("class_code"),
            address_line1=row.get("address_line1"),
            address_line2=row.get("address_line2"),
            address_line3=row.get("address_line3"),
            city=row.get("city"),
            state=row.get("state") or "FL",
            zip=row.get("zip"),
            county_code=row.get("county_code"),
            county_name=county,
            license_status=row.get("primary_status"),
            secondary_status=row.get("secondary_status"),
            signals={"metro": metro, "source": "dbpr"},
        )
        out.append(prospect)

    log.info(
        "Filtered to %d CCC prospects in metros %s (from %d raw rows)",
        len(out),
        metros,
        len(rows),
    )
    return out


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
    )
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--metros",
        default=",".join(METRO_COUNTIES.keys()),
        help="Comma-separated metro keys",
    )
    parser.add_argument("--csv", type=Path, help="Use local CSV instead of download")
    parser.add_argument("-o", "--output", type=Path, help="Write JSON seed list")
    args = parser.parse_args(argv)

    metros = [m.strip() for m in args.metros.split(",") if m.strip()]
    if args.csv:
        rows = parse_dbpr_csv(args.csv)
    else:
        path = download_dbpr()
        rows = parse_dbpr_csv(path)

    prospects = filter_roofing_prospects(rows, metros=metros)
    out_path = args.output or (Path(__file__).resolve().parents[2] / "data" / "contractor-intel" / "seed.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = [p.to_db_row() for p in prospects]
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {len(prospects)} prospects → {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
