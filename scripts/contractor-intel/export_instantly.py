#!/usr/bin/env python3
"""Re-export ranked prospects to Instantly CSV from a master spreadsheet (no DB required)."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from config import DATA_DIR, DEFAULT_TOP_N, MIN_EXPORT_SCORE, OUTPUT_DIR
from csv_io import load_prospects_from_csv, write_pipeline_csvs
from score import rank_prospects

log = logging.getLogger("contractor_intel.export_instantly")


def _default_input() -> Path | None:
    for candidate in (
        OUTPUT_DIR / "contractor_prospects_latest.csv",
        DATA_DIR / "latest_prospects.csv",  # legacy json path replaced — check csv
        DATA_DIR / "seed_latest.csv",
    ):
        if candidate.exists():
            return candidate
    legacy_json = DATA_DIR / "latest_prospects.json"
    if legacy_json.exists():
        return legacy_json
    return None


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
    )
    parser = argparse.ArgumentParser(
        description="Build Instantly CSV from contractor_prospects_latest.csv"
    )
    parser.add_argument(
        "--input",
        type=Path,
        default=None,
        help="Master CSV (default: output/contractor_prospects_latest.csv)",
    )
    parser.add_argument("--top", type=int, default=DEFAULT_TOP_N)
    parser.add_argument("--min-score", type=float, default=MIN_EXPORT_SCORE)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=OUTPUT_DIR,
        help="Where to write instantly_*.csv",
    )
    args = parser.parse_args(argv)

    input_path = args.input or _default_input()
    if not input_path or not input_path.exists():
        print(
            "No input file. Run the pipeline first:\n"
            "  npm run intel:pipeline\n"
            "Or pass --input output/contractor_prospects_latest.csv",
            file=sys.stderr,
        )
        return 1

    if input_path.suffix.lower() == ".json":
        import json
        from models import ContractorProspect

        raw = json.loads(input_path.read_text(encoding="utf-8"))
        prospects = []
        for row in raw:
            signals = row.pop("signals", {})
            if isinstance(signals, str):
                signals = json.loads(signals)
            prospects.append(ContractorProspect(**row, signals=signals or {}))
    else:
        prospects = load_prospects_from_csv(input_path)

    ranked = rank_prospects(
        prospects, top_n=args.top, min_score=args.min_score
    )
    outputs = write_pipeline_csvs(
        seed=prospects,
        all_prospects=prospects,
        ranked=ranked,
        output_dir=args.output_dir,
    )

    print(f"\nInstantly upload: {outputs.instantly_latest}")
    print(f"Review sheet:     {outputs.review}")
    print(f"Rows:             {len(ranked)} / top {args.top}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
