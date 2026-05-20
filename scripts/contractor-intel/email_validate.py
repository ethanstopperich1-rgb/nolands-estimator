"""Email syntax + MX validation."""

from __future__ import annotations

import re

try:
    import dns.resolver
except ImportError:
    dns = None  # type: ignore

EMAIL_RE = re.compile(
    r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$"
)

FREE_EMAIL_DOMAINS = frozenset(
    {
        "gmail.com",
        "yahoo.com",
        "hotmail.com",
        "outlook.com",
        "aol.com",
        "icloud.com",
    }
)


def is_valid_syntax(email: str) -> bool:
    e = (email or "").strip().lower()
    if not e or " " in e:
        return False
    return bool(EMAIL_RE.match(e))


def has_mx(domain: str) -> bool:
    if not dns:
        return True  # fail-open if dnspython missing
    try:
        answers = dns.resolver.resolve(domain, "MX")
        return len(answers) > 0
    except Exception:
        try:
            dns.resolver.resolve(domain, "A")
            return True
        except Exception:
            return False


def validate_email(email: str) -> bool:
    e = email.strip().lower()
    if not is_valid_syntax(e):
        return False
    domain = e.split("@", 1)[1]
    return has_mx(domain)
