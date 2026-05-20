#!/usr/bin/env python3
"""Download and cache the FL DBPR construction licensee bulk file."""

from __future__ import annotations

import argparse
import csv
import io
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx

from browser import browser_session, cloakbrowser_available, fetch_url_bytes
from config import DATA_DIR, DBPR_COLUMNS, DBPR_URL, USER_AGENT

log = logging.getLogger("contractor_intel.dbpr_fetch")


def _dbpr_paths() -> tuple[Path, Path]:
    raw_dir = DATA_DIR / "dbpr"
    raw_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    return raw_dir / f"CONSTRUCTIONLICENSE_1_{stamp}.csv", raw_dir / "CONSTRUCTIONLICENSE_1_latest.csv"


def _fetch_httpx() -> bytes:
    log.info("Trying httpx download: %s", DBPR_URL)
    with httpx.Client(
        timeout=120.0,
        follow_redirects=True,
        headers={"User-Agent": USER_AGENT, "Accept": "text/csv,*/*"},
    ) as client:
        resp = client.get(DBPR_URL)
        resp.raise_for_status()
        return resp.content


def _fetch_cloakbrowser() -> bytes:
    log.info("httpx blocked — using CloakBrowser for DBPR download")
    with browser_session() as page:
        return fetch_url_bytes(page, DBPR_URL)


def download_dbpr(*, force: bool = False) -> Path:
    dated_path, latest_path = _dbpr_paths()
    if latest_path.exists() and not force:
        log.info("Using cached DBPR file: %s", latest_path)
        return latest_path

    try:
        content = _fetch_httpx()
    except Exception as e:
        log.warning("httpx download failed: %s", e)
        if not cloakbrowser_available():
            raise RuntimeError(
                "DBPR download failed and cloakbrowser is not installed."
            ) from e
        content = _fetch_cloakbrowser()

    if len(content) < 10_000:
        raise RuntimeError(
            f"DBPR download suspiciously small ({len(content)} bytes) — likely blocked HTML"
        )

    dated_path.write_bytes(content)
    latest_path.write_bytes(content)
    log.info("Wrote %s (%d bytes)", latest_path, len(content))
    return latest_path


def parse_dbpr_csv(path: Path) -> list[dict[str, str]]:
    """Parse quote/comma DBPR extract (no header row)."""
    text = path.read_text(encoding="utf-8", errors="replace")
    reader = csv.reader(io.StringIO(text))
    rows: list[dict[str, str]] = []
    for raw in reader:
        if not raw or all(not (c or "").strip() for c in raw):
            continue
        padded = raw + [""] * max(0, len(DBPR_COLUMNS) - len(raw))
        row = {
            DBPR_COLUMNS[i]: (padded[i] or "").strip()
            for i in range(len(DBPR_COLUMNS))
        }
        if row.get("license_number"):
            rows.append(row)
    log.info("Parsed %d DBPR rows from %s", len(rows), path)
    return rows


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
    )
    parser = argparse.ArgumentParser(description="Fetch FL DBPR construction CSV")
    parser.add_argument("--force", action="store_true", help="Re-download even if cached")
    args = parser.parse_args(argv)

    path = download_dbpr(force=args.force)
    rows = parse_dbpr_csv(path)
    print(f"OK: {len(rows)} rows → {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
