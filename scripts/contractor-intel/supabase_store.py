"""Persist contractor prospects to Supabase (service role)."""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Iterable

import psycopg
from psycopg.types.json import Jsonb

from models import ContractorProspect

log = logging.getLogger("contractor_intel.supabase_store")

UPSERT_SQL = """
insert into public.contractor_prospects (
  license_number, board_number, occupation_code, licensee_name, dba_name,
  class_code, address_line1, address_line2, address_line3, city, state, zip,
  county_code, county_name, license_status, secondary_status,
  website, domain, contact_first_name, contact_last_name, contact_title,
  email, email_confidence, phone, lead_score, signals,
  enrichment_status, exclude_reason, last_scraped_at, updated_at
) values (
  %(license_number)s, %(board_number)s, %(occupation_code)s, %(licensee_name)s,
  %(dba_name)s, %(class_code)s, %(address_line1)s, %(address_line2)s,
  %(address_line3)s, %(city)s, %(state)s, %(zip)s, %(county_code)s,
  %(county_name)s, %(license_status)s, %(secondary_status)s,
  %(website)s, %(domain)s, %(contact_first_name)s, %(contact_last_name)s,
  %(contact_title)s, %(email)s, %(email_confidence)s, %(phone)s,
  %(lead_score)s, %(signals)s, %(enrichment_status)s, %(exclude_reason)s,
  %(last_scraped_at)s, now()
)
on conflict (license_number) do update set
  website = excluded.website,
  domain = excluded.domain,
  contact_first_name = excluded.contact_first_name,
  contact_last_name = excluded.contact_last_name,
  contact_title = excluded.contact_title,
  email = excluded.email,
  email_confidence = excluded.email_confidence,
  phone = excluded.phone,
  lead_score = excluded.lead_score,
  signals = excluded.signals,
  enrichment_status = excluded.enrichment_status,
  exclude_reason = excluded.exclude_reason,
  last_scraped_at = excluded.last_scraped_at,
  updated_at = now()
"""


def _db_url() -> str:
    url = os.environ.get("SUPABASE_DB_URL") or os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("Set SUPABASE_DB_URL (service-role Postgres connection string)")
    return url


def _norm_name(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def load_office_exclusions(conn) -> tuple[set[str], set[str]]:
    """Return normalized office names and domains to exclude."""
    names: set[str] = set()
    domains: set[str] = set()
    with conn.cursor() as cur:
        cur.execute(
            "select lower(name), lower(coalesce(slug, '')) from public.offices where is_active = true"
        )
        for name, slug in cur.fetchall():
            names.add(_norm_name(name))
            if slug:
                names.add(_norm_name(slug))
    # Known Voxaris / pipeline customers
    names.update(
        {
            _norm_name("Noland's Roofing"),
            _norm_name("Nolands Roofing"),
            _norm_name("Voxaris"),
        }
    )
    domains.update({"voxaris.io", "nolandsroofing.com"})
    return names, domains


def apply_exclusions(
    prospects: list[ContractorProspect],
    office_names: set[str],
    office_domains: set[str],
) -> None:
    for p in prospects:
        dn = _norm_name(p.display_name)
        if dn in office_names:
            p.exclude_reason = "existing_office"
            p.enrichment_status = "excluded"
            continue
        if p.domain and p.domain.lower() in office_domains:
            p.exclude_reason = "existing_office_domain"
            p.enrichment_status = "excluded"


def _upsert_row(p: ContractorProspect) -> dict:
    row = {
        "license_number": p.license_number,
        "board_number": p.board_number,
        "occupation_code": p.occupation_code,
        "licensee_name": p.licensee_name,
        "dba_name": p.dba_name,
        "class_code": p.class_code,
        "address_line1": p.address_line1,
        "address_line2": p.address_line2,
        "address_line3": p.address_line3,
        "city": p.city,
        "state": p.state,
        "zip": p.zip,
        "county_code": p.county_code,
        "county_name": p.county_name,
        "license_status": p.license_status,
        "secondary_status": p.secondary_status,
        "website": p.website,
        "domain": p.domain,
        "contact_first_name": p.contact_first_name,
        "contact_last_name": p.contact_last_name,
        "contact_title": p.contact_title,
        "email": p.email,
        "email_confidence": p.email_confidence,
        "phone": p.phone,
        "lead_score": p.lead_score,
        "signals": Jsonb(p.signals),
        "enrichment_status": p.enrichment_status,
        "exclude_reason": p.exclude_reason,
        "last_scraped_at": p.last_scraped_at,
    }
    return row


def upsert_prospects(prospects: Iterable[ContractorProspect]) -> int:
    url = _db_url()
    count = 0
    with psycopg.connect(url) as conn:
        office_names, office_domains = load_office_exclusions(conn)
        batch = list(prospects)
        apply_exclusions(batch, office_names, office_domains)

        with conn.cursor() as cur:
            for p in batch:
                cur.execute(UPSERT_SQL, _upsert_row(p))
                count += 1
        conn.commit()
    log.info("Upserted %d contractor_prospects rows", count)
    return count


def fetch_prospects_for_export(
    *,
    min_score: float = 55.0,
    limit: int = 200,
) -> list[ContractorProspect]:
    url = _db_url()
    sql = """
      select license_number, board_number, occupation_code, licensee_name, dba_name,
             class_code, address_line1, address_line2, address_line3, city, state, zip,
             county_code, county_name, license_status, secondary_status,
             website, domain, contact_first_name, contact_last_name, contact_title,
             email, email_confidence, phone, lead_score, signals,
             enrichment_status, exclude_reason
      from public.contractor_prospects
      where enrichment_status = 'export_ready'
        and exclude_reason is null
        and email is not null
        and email_confidence in ('high', 'medium')
        and lead_score >= %s
      order by lead_score desc
      limit %s
    """
    out: list[ContractorProspect] = []
    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (min_score, limit))
            cols = [d[0] for d in cur.description]
            for raw in cur.fetchall():
                data = dict(zip(cols, raw))
                signals = data.pop("signals") or {}
                if isinstance(signals, str):
                    signals = json.loads(signals)
                score = data.get("lead_score")
                if score is not None:
                    data["lead_score"] = float(score)
                out.append(ContractorProspect(**data, signals=signals))
    return out


def mark_instantly_exported(license_numbers: list[str]) -> None:
    if not license_numbers:
        return
    url = _db_url()
    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                update public.contractor_prospects
                set instantly_exported_at = now(), updated_at = now()
                where license_number = any(%s)
                """,
                (license_numbers,),
            )
        conn.commit()
    log.info("Marked %d prospects as exported to Instantly", len(license_numbers))
