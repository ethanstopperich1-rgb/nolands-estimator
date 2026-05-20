"""Parse DBPR / Sunbiz-style person names into first + last."""

from __future__ import annotations

import re

_SUFFIXES = frozenset({"JR", "SR", "II", "III", "IV", "ESQ"})


def parse_owner_name(raw: str | None) -> tuple[str | None, str | None]:
    """
    DBPR licensee_name is usually 'LAST, FIRST MIDDLE SUFFIX'.
    Returns (first_name, last_name) title-cased for email construction.
    """
    if not raw:
        return None, None
    text = re.sub(r"\s+", " ", raw.strip())
    if not text:
        return None, None

    if "," in text:
        last_part, rest = text.split(",", 1)
        last = _clean_token(last_part)
        tokens = [_clean_token(t) for t in rest.split() if _clean_token(t)]
        tokens = [t for t in tokens if t.upper() not in _SUFFIXES]
        if not tokens:
            return None, last
        first = tokens[0]
        return first, last

    tokens = [_clean_token(t) for t in text.split() if _clean_token(t)]
    if len(tokens) >= 2:
        return tokens[0], tokens[-1]
    if len(tokens) == 1:
        return tokens[0], None
    return None, None


def _clean_token(token: str) -> str | None:
    t = token.strip().strip(".")
    if not t or len(t) < 2:
        return None
    if t.isupper():
        return t.title()
    return t[0].upper() + t[1:].lower() if len(t) > 1 else t.upper()
