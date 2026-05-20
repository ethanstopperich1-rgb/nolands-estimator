"""Email pattern detection and construction (first@, first.last@, etc.)."""

from __future__ import annotations

import re
from typing import Iterable

# Hunter-style tokens: {first}, {last}, {f}
STANDARD_PATTERNS = (
    "{first}",
    "{first}.{last}",
    "{first}{last}",
    "{f}{last}",
)

ROLE_LOCALS = frozenset(
    {
        "info",
        "contact",
        "sales",
        "office",
        "hello",
        "support",
        "service",
        "estimates",
        "estimate",
        "admin",
    }
)


def _norm_local(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def apply_pattern(
    pattern: str,
    *,
    first: str,
    last: str,
    domain: str,
) -> str:
    """Render Hunter-style pattern to an email address."""
    f = first[0].lower() if first else ""
    first_l = _norm_local(first)
    last_l = _norm_local(last)
    local = (
        pattern.replace("{first}", first_l)
        .replace("{last}", last_l)
        .replace("{f}", f)
    )
    local = re.sub(r"[^a-z0-9.]", "", local)
    return f"{local}@{domain.lower()}"


def infer_pattern_from_email(
    email: str,
    *,
    first: str | None,
    last: str | None,
) -> str | None:
    """Guess pattern string from a known named mailbox."""
    if not first or not last:
        return None
    try:
        local, domain_part = email.lower().split("@", 1)
    except ValueError:
        return None
    if local in ROLE_LOCALS:
        return None

    first_l = _norm_local(first)
    last_l = _norm_local(last)
    f = first_l[0] if first_l else ""

    candidates = {
        first_l: "{first}",
        f"{first_l}.{last_l}": "{first}.{last}",
        f"{first_l}{last_l}": "{first}{last}",
        f"{f}{last_l}": "{f}{last}",
    }
    return candidates.get(local)


def build_candidates(
    *,
    first: str,
    last: str,
    domain: str,
    patterns: Iterable[str] | None = None,
) -> list[str]:
    """All pattern variants for an owner at a domain."""
    if not first or not last:
        return []
    pats = patterns or STANDARD_PATTERNS
    out: list[str] = []
    seen: set[str] = set()
    for p in pats:
        addr = apply_pattern(p, first=first, last=last, domain=domain)
        if addr not in seen:
            seen.add(addr)
            out.append(addr)
    return out
