"""Shared configuration for the FL contractor intelligence pipeline."""

from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "data" / "contractor-intel"
OUTPUT_DIR = REPO_ROOT / "output"

DBPR_URL = (
    "https://www2.myfloridalicense.com/sto/file_download/extracts/"
    "CONSTRUCTIONLICENSE_1.csv"
)

CONTACT_EMAIL = os.environ.get("CONTACT_EMAIL", "admin@voxaris.io")
USER_AGENT = f"Voxaris-ContractorIntel (+{CONTACT_EMAIL})"

# DBPR construction licensee file — quote/comma, no header row.
# https://www2.myfloridalicense.com/construction-industry/public-records/
DBPR_COLUMNS = [
    "board_number",
    "occupation_code",
    "licensee_name",
    "dba_name",
    "class_code",
    "address_line1",
    "address_line2",
    "address_line3",
    "city",
    "state",
    "zip",
    "county_code",
    "license_number",
    "primary_status",
    "secondary_status",
    "original_license_date",
    "effective_date",
    "expiration_date",
    "blank",
    "renewal_period",
    "alternate_license",
]

# DBPR stores certification type in occupation_code (col 1), not class_code (col 4).
ROOFING_OCCUPATION_CODES = frozenset({"CCC"})

ACTIVE_STATUS_KEYWORDS = frozenset(
    {"C", "CURRENT", "ACTIVE", "CLEAR", "LICENSED", "VALID"}
)

# DBPR numeric county codes observed in CONSTRUCTIONLICENSE extract (2026-05).
METRO_COUNTY_DBPR_CODES: dict[str, frozenset[str]] = {
    "orlando": frozenset({"58", "069", "69", "48", "047", "47", "34"}),
    "tampa": frozenset({"39", "051", "51", "50", "027", "27", "57"}),
    "jacksonville": frozenset({"26", "065", "65", "59", "054", "54", "010", "10"}),
    "miami": frozenset({"23", "016", "16", "06", "006", "11", "011"}),
    "naples": frozenset({"11", "011", "35", "035"}),
    "fort_myers": frozenset({"35", "035", "08", "008"}),
}

# Florida county names by DBPR-style numeric county code (common CILB extract).
FL_COUNTY_BY_CODE: dict[str, str] = {
    "01": "ALACHUA",
    "02": "BAKER",
    "03": "BAY",
    "04": "BRADFORD",
    "05": "BREVARD",
    "06": "BROWARD",
    "07": "CALHOUN",
    "08": "CHARLOTTE",
    "09": "CITRUS",
    "10": "CLAY",
    "11": "COLLIER",
    "12": "COLUMBIA",
    "13": "DADE",
    "14": "DESOTO",
    "15": "DIXIE",
    "16": "DUVAL",
    "17": "ESCAMBIA",
    "18": "FLAGLER",
    "19": "FRANKLIN",
    "20": "GADSDEN",
    "21": "GILCHRIST",
    "22": "GLADES",
    "23": "GULF",
    "24": "HAMILTON",
    "25": "HARDEE",
    "26": "HENDRY",
    "27": "HERNANDO",
    "28": "HIGHLANDS",
    "29": "HOLMES",
    "30": "INDIAN RIVER",
    "31": "JACKSON",
    "32": "JEFFERSON",
    "33": "LAFAYETTE",
    "34": "LAKE",
    "35": "LEE",
    "36": "LEON",
    "37": "LEVY",
    "38": "LIBERTY",
    "39": "MADISON",
    "40": "MANATEE",
    "41": "MARION",
    "42": "MARTIN",
    "43": "MONROE",
    "44": "NASSAU",
    "45": "OKALOOSA",
    "46": "OKEECHOBEE",
    "47": "ORANGE",
    "48": "OSCEOLA",
    "49": "PALM BEACH",
    "50": "PASCO",
    "51": "PINELLAS",
    "52": "POLK",
    "53": "PUTNAM",
    "54": "ST. JOHNS",
    "55": "ST. LUCIE",
    "56": "SANTA ROSA",
    "57": "SARASOTA",
    "58": "SEMINOLE",
    "59": "SUMTER",
    "60": "SUWANNEE",
    "61": "TAYLOR",
    "62": "UNION",
    "63": "VOLUSIA",
    "64": "WAKULLA",
    "65": "WALTON",
    "66": "WASHINGTON",
    # Some extracts zero-pad to 3 digits
    "047": "ORANGE",
    "058": "SEMINOLE",
    "048": "OSCEOLA",
    "034": "LAKE",
    "016": "DUVAL",
    "054": "ST. JOHNS",
    "010": "CLAY",
    "044": "NASSAU",
    "006": "BROWARD",
    "013": "DADE",
    "011": "COLLIER",
    "035": "LEE",
    "027": "HERNANDO",
    "050": "PASCO",
    "051": "PINELLAS",
    "052": "POLK",
    "053": "PUTNAM",
    "057": "SARASOTA",
}

METRO_COUNTIES: dict[str, frozenset[str]] = {
    "orlando": frozenset(
        {"ORANGE", "SEMINOLE", "OSCEOLA", "LAKE", "VOLUSIA", "BREVARD"}
    ),
    "tampa": frozenset(
        {
            "HILLSBOROUGH",
            "PINELLAS",
            "PASCO",
            "HERNANDO",
            "MANATEE",
            "SARASOTA",
            "POLK",
        }
    ),
    "jacksonville": frozenset(
        {"DUVAL", "ST. JOHNS", "CLAY", "NASSAU", "BAKER"}
    ),
    "miami": frozenset({"DADE", "BROWARD", "PALM BEACH", "MIAMI-DADE"}),
    "naples": frozenset({"COLLIER", "LEE"}),
    "fort_myers": frozenset({"LEE", "CHARLOTTE", "COLLIER"}),
}

# Hillsborough sometimes appears as code 57 in older docs — add alias cities
METRO_CITY_ALIASES: dict[str, frozenset[str]] = {
    "orlando": frozenset(
        {
            "ORLANDO",
            "WINTER PARK",
            "KISSIMMEE",
            "SANFORD",
            "ALTAMONTE SPRINGS",
            "OVIEDO",
            "LAKE MARY",
            "APOPKA",
            "CLERMONT",
            "DAYTONA BEACH",
        }
    ),
    "tampa": frozenset(
        {
            "TAMPA",
            "ST. PETERSBURG",
            "ST PETERSBURG",
            "CLEARWATER",
            "BRANDON",
            "LARGO",
            "PLANT CITY",
            "SARASOTA",
            "LAKELAND",
        }
    ),
    "jacksonville": frozenset(
        {"JACKSONVILLE", "JACKSONVILLE BEACH", "ORANGE PARK", "FLEMING ISLAND"}
    ),
    "miami": frozenset(
        {
            "MIAMI",
            "FORT LAUDERDALE",
            "HOLLYWOOD",
            "PEMBROKE PINES",
            "HIALEAH",
            "CORAL GABLES",
            "BOCA RATON",
            "WEST PALM BEACH",
        }
    ),
    "naples": frozenset({"NAPLES", "MARCO ISLAND", "BONITA SPRINGS"}),
    "fort_myers": frozenset({"FORT MYERS", "CAPE CORAL", "LEHIGH ACRES", "ESTERO"}),
}

HILLSBOROUGH_COUNTY_CODES = frozenset({"53", "053"})  # verify on first run

TITLE_KEYWORDS = (
    "owner",
    "president",
    "ceo",
    "chief executive",
    "general manager",
    "managing partner",
    "founder",
    "principal",
    "vp operations",
    "vice president",
)

DECISION_TITLE_RE = (
    r"(?i)\b(owner|president|ceo|general manager|gm|founder|principal)\b"
)

STACK_KEYWORDS = {
    "jobnimbus": 5,
    "acculynx": 5,
    "eagleview": 4,
    "roofr": 4,
    "hover": 3,
    "companycam": 3,
    "servicetitan": 5,
    "salesforce": 3,
    "hubspot": 3,
    "calendly": 2,
    "drift": 2,
    "intercom": 2,
    "free estimate": 4,
    "instant estimate": 4,
    "schedule inspection": 3,
}

# BuiltWith technology Name → STACK_KEYWORDS key (normalized name lookup).
BUILTWITH_TECH_ALIASES: dict[str, str] = {
    "jobnimbus": "jobnimbus",
    "acculynx": "acculynx",
    "eagleview": "eagleview",
    "roofr": "roofr",
    "hover": "hover",
    "hoverapp": "hover",
    "companycam": "companycam",
    "servicetitan": "servicetitan",
    "servicetitaninc": "servicetitan",
}

NEGATIVE_KEYWORDS = {
    "solar only": -15,
    "solar panel": -8,
    "property management": -15,
    "handyman": -10,
    "gutter only": -8,
}

SCRAPE_PATHS = (
    "/",
    "/contact",
    "/contact-us",
    "/about",
    "/about-us",
    "/team",
    "/our-team",
    "/leadership",
    "/company",
)

# Smoke tests / quick runs — fewer pages, much faster per company.
FAST_SCRAPE_PATHS = ("/", "/contact", "/contact-us", "/about")

GENERIC_EMAIL_LOCALS = frozenset(
    {
        "noreply",
        "no-reply",
        "donotreply",
        "support",
        "help",
        "hr",
        "careers",
        "jobs",
        "billing",
        "accounting",
    }
)

ROLE_EMAIL_LOCALS = frozenset(
    {
        "info",
        "contact",
        "hello",
        "office",
        "sales",
        "service",
        "estimates",
        "estimate",
    }
)

DEFAULT_TOP_N = int(os.environ.get("INTEL_TOP_N", "200"))
MIN_EXPORT_SCORE = float(os.environ.get("INTEL_MIN_EXPORT_SCORE", "55"))
MIN_EMAIL_CONFIDENCE = os.environ.get("INTEL_MIN_EMAIL_CONFIDENCE", "medium")

DEMO_URL = "https://pitch.voxaris.io"

RATE_LIMIT_MIN_SEC = 2.0
RATE_LIMIT_MAX_SEC = 4.0
