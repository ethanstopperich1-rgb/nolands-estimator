#!/usr/bin/env python3
"""
FL roofing contractor intelligence pipeline → CSV files (primary output).

Writes to output/:
  contractor_prospects_latest.csv   — full enriched list (open in Excel/Sheets)
  instantly_fl_roofing_latest.csv   — top N for Instantly upload
  review_fl_roofing_YYYYMMDD.csv    — QA columns

Usage:
  npm run intel:pipeline
  python3 scripts/contractor-intel/run_pipeline.py --limit 20 --metros orlando

Optional: --save-db  persists to Supabase when SUPABASE_DB_URL is set.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from config import DATA_DIR, DEFAULT_TOP_N, MIN_EXPORT_SCORE, OUTPUT_DIR
from csv_io import CsvOutputs, write_csv_file, write_pipeline_csvs, write_progress_snapshot
from dbpr_fetch import download_dbpr, parse_dbpr_csv
from dbpr_filter import filter_roofing_prospects
from discover_web import enrich_websites
from models import ContractorProspect
from score import rank_prospects
from apollo_enrich import apollo_api_key, enrich_with_apollo
from builtwith_enrich import builtwith_api_key, enrich_stack_builtwith
from free_enrich import enrich_free
from scrape_contacts import enrich_contacts

log = logging.getLogger("contractor_intel.pipeline")


def run(
    *,
    metros: list[str],
    top_n: int,
    min_score: float,
    limit: int | None,
    save_db: bool,
    force_browser: bool,
    fast: bool,
    enrich_mode: str,
    stack_mode: str,
    no_smtp_verify: bool,
    dbpr_csv: Path | None,
    output_dir: Path,
) -> tuple[list[ContractorProspect], list[ContractorProspect], CsvOutputs]:
    if dbpr_csv:
        rows = parse_dbpr_csv(dbpr_csv)
    else:
        path = download_dbpr()
        rows = parse_dbpr_csv(path)

    seed = filter_roofing_prospects(rows, metros=metros)
    if limit:
        seed = seed[:limit]
        log.info("Limited to %d prospects for this run", limit)

    output_dir.mkdir(parents=True, exist_ok=True)
    seed_path = output_dir / "contractor_seed_latest.csv"
    write_csv_file(seed_path, seed, kind="seed")
    log.info("Wrote seed CSV (open while scrape runs): %s", seed_path)

    prospects = list(seed)
    enrich_websites(prospects)
    with_site = [p for p in prospects if p.domain or p.website]
    log.info("%d / %d have websites", len(with_site), len(prospects))
    write_progress_snapshot(prospects, output_dir=output_dir, label="websites_found")

    stack = stack_mode
    if stack == "auto":
        stack = "builtwith" if builtwith_api_key() else "off"
    if stack == "builtwith":
        log.info("Stack detection: BuiltWith Domain API")
        enrich_stack_builtwith(
            prospects,
            limit=limit,
            on_progress=lambda: write_progress_snapshot(
                prospects, output_dir=output_dir, label="builtwith"
            ),
        )
    elif stack == "free":
        log.info("Stack detection: BuiltWith Free API (category summary only)")
        enrich_stack_builtwith(
            prospects,
            limit=limit,
            use_free_tier=True,
            on_progress=lambda: write_progress_snapshot(
                prospects, output_dir=output_dir, label="builtwith"
            ),
        )

    def _flush_progress() -> None:
        write_progress_snapshot(prospects, output_dir=output_dir, label="scrape")

    mode = enrich_mode
    if mode == "auto":
        # Default: free pattern+Hunter+SMTP; paid Apollo only if explicitly configured
        if apollo_api_key() and os.environ.get("INTEL_PREFER_APOLLO") == "1":
            mode = "apollo"
        else:
            mode = "free"

    if mode == "free-scrape":
        log.info("Contact enrichment: free then scrape remaining")
        enrich_free(
            prospects,
            limit=limit,
            on_progress=_flush_progress,
            smtp_verify=not no_smtp_verify,
        )

    if mode == "free":
        log.info("Contact enrichment: free (pattern + Hunter + SMTP verify)")
        enrich_free(
            prospects,
            limit=limit,
            on_progress=_flush_progress,
            use_hunter=True,
            smtp_verify=not no_smtp_verify,
        )
    elif mode in ("apollo", "apollo-first"):
        log.info("Contact enrichment: Apollo (%s)", mode)
        enrich_with_apollo(
            prospects,
            limit=limit,
            on_progress=_flush_progress,
            skip_if_email=False,
        )
    if mode in ("scrape", "apollo-first", "free-scrape"):
        if mode == "scrape":
            log.info("Contact enrichment: website scrape")
        else:
            missing = sum(1 for p in prospects if not p.email)
            if missing:
                log.info(
                    "Apollo-first: scraping %d prospects still without email",
                    missing,
                )
        enrich_contacts(
            prospects,
            limit=limit,
            force_browser=force_browser,
            fast=fast,
            on_progress=_flush_progress,
        )

    ranked = rank_prospects(prospects, top_n=top_n, min_score=min_score)

    outputs = write_pipeline_csvs(
        seed=seed,
        all_prospects=prospects,
        ranked=ranked,
        output_dir=output_dir,
    )

    if save_db and os.environ.get("SUPABASE_DB_URL"):
        from supabase_store import upsert_prospects

        upsert_prospects(prospects)
        log.info("Also saved to Supabase contractor_prospects")
    else:
        log.info("CSV-only run (use --save-db + SUPABASE_DB_URL to persist to DB)")

    return prospects, ranked, outputs


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
    )
    parser = argparse.ArgumentParser(
        description="FL contractor intel → CSV (Instantly-ready)"
    )
    parser.add_argument(
        "--metros",
        default="orlando,tampa,jacksonville,miami,naples,fort_myers",
        help="Comma-separated metro keys",
    )
    parser.add_argument("--top", type=int, default=DEFAULT_TOP_N)
    parser.add_argument("--min-score", type=float, default=MIN_EXPORT_SCORE)
    parser.add_argument("--limit", type=int, help="Cap seed/enrich count (smoke test)")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=OUTPUT_DIR,
        help=f"CSV output directory (default: {OUTPUT_DIR})",
    )
    parser.add_argument(
        "--save-db",
        action="store_true",
        help="Also upsert to Supabase (requires SUPABASE_DB_URL)",
    )
    parser.add_argument(
        "--force-browser",
        action="store_true",
        help="Use CloakBrowser for all site scrapes",
    )
    parser.add_argument(
        "--fast",
        action="store_true",
        help="Scrape fewer pages per site (faster smoke tests)",
    )
    parser.add_argument(
        "--enrich",
        choices=("auto", "free", "apollo", "scrape", "apollo-first", "free-scrape"),
        default="auto",
        help="auto=free (pattern+Hunter+SMTP); free-scrape=free then scrape gaps",
    )
    parser.add_argument(
        "--stack",
        choices=("auto", "builtwith", "free", "off"),
        default="auto",
        help="auto=BuiltWith v22 if BUILTWITH_API_KEY; free=free1 API; off=skip",
    )
    parser.add_argument(
        "--no-smtp-verify",
        action="store_true",
        help="Skip SMTP RCPT checks in free mode (faster, unverified emails)",
    )
    parser.add_argument("--dbpr-csv", type=Path, help="Local DBPR CSV (skip download)")
    args = parser.parse_args(argv)

    metros = [m.strip() for m in args.metros.split(",") if m.strip()]
    _prospects, ranked, outputs = run(
        metros=metros,
        top_n=args.top,
        min_score=args.min_score,
        limit=args.limit,
        save_db=args.save_db,
        force_browser=args.force_browser,
        fast=args.fast,
        enrich_mode=args.enrich,
        stack_mode=args.stack,
        no_smtp_verify=args.no_smtp_verify,
        dbpr_csv=args.dbpr_csv,
        output_dir=args.output_dir,
    )

    print("\nWhile running, open: output/contractor_prospects_latest.csv (updates each company)")

    print("\n--- CSV outputs ---")
    print(f"Full list (spreadsheet):  {outputs.master_latest}")
    print(f"Instantly upload:       {outputs.instantly_latest}")
    print(f"Review / QA:              {outputs.review}")
    print(f"DBPR seed (filtered):     {outputs.seed}")
    print(f"\nExport-ready: {len(ranked)} / top {args.top}")
    if len(ranked) < args.top:
        print(
            "Tip: add APOLLO_API_KEY and use --enrich apollo, or re-run with --force-browser."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
