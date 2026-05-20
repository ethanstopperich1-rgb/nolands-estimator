"""Data models for contractor prospects."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from typing import Any


@dataclass
class ContractorProspect:
    license_number: str
    board_number: str | None = None
    occupation_code: str | None = None
    licensee_name: str | None = None
    dba_name: str | None = None
    class_code: str | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    address_line3: str | None = None
    city: str | None = None
    state: str | None = None
    zip: str | None = None
    county_code: str | None = None
    county_name: str | None = None
    license_status: str | None = None
    secondary_status: str | None = None
    original_license_date: date | None = None
    expiration_date: date | None = None
    website: str | None = None
    domain: str | None = None
    contact_first_name: str | None = None
    contact_last_name: str | None = None
    contact_title: str | None = None
    email: str | None = None
    email_confidence: str | None = None
    phone: str | None = None
    lead_score: float = 0.0
    signals: dict[str, Any] = field(default_factory=dict)
    enrichment_status: str = "discovered"
    exclude_reason: str | None = None
    last_scraped_at: datetime | None = None
    instantly_exported_at: datetime | None = None

    @property
    def display_name(self) -> str:
        dba = (self.dba_name or "").strip()
        if dba:
            return dba
        return (self.licensee_name or "").strip() or self.license_number

    @property
    def metro(self) -> str | None:
        m = self.signals.get("metro")
        return str(m) if m else None

    def to_db_row(self) -> dict[str, Any]:
        row = asdict(self)
        row["signals"] = json.dumps(self.signals)
        for key in ("original_license_date", "expiration_date"):
            val = row.get(key)
            if isinstance(val, date):
                row[key] = val.isoformat()
        for key in ("last_scraped_at", "instantly_exported_at"):
            val = row.get(key)
            if isinstance(val, datetime):
                row[key] = val.isoformat()
        return row
