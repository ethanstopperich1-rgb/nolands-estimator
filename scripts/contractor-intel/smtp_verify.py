"""SMTP RCPT-TO verification (mailtester-style, no API key)."""

from __future__ import annotations

import logging
import random
import smtplib
import socket
import time
from typing import Literal

try:
    import dns.resolver
except ImportError:
    dns = None  # type: ignore

log = logging.getLogger("contractor_intel.smtp_verify")

VerifyStatus = Literal["valid", "invalid", "unknown", "accept_all"]

# Be polite to recipient MX hosts.
VERIFY_DELAY_SEC = 2.0


def _mx_hosts(domain: str) -> list[str]:
    if not dns:
        return [domain]
    try:
        answers = dns.resolver.resolve(domain, "MX")
        pairs = sorted(
            (r.preference, str(r.exchange).rstrip(".")) for r in answers
        )
        return [host for _, host in pairs]
    except Exception:
        return [domain]


def verify_smtp(email: str, *, timeout: float = 12.0) -> VerifyStatus:
    """
    Check if mailbox likely exists via SMTP RCPT TO.
    Many servers greylist or always accept — treat accept_all separately.
    """
    email = email.strip().lower()
    if "@" not in email:
        return "invalid"
    local, domain = email.split("@", 1)

    mx_hosts = _mx_hosts(domain)
    from_addr = f"verify@{domain}"
    unknown_count = 0

    for mx in mx_hosts[:3]:
        try:
            with smtplib.SMTP(timeout=timeout) as smtp:
                smtp.connect(mx, 25)
                smtp.ehlo_or_helo_if_needed()
                smtp.mail(from_addr)
                code, _ = smtp.rcpt(email)
                if code in (250, 251):
                    # Probe random address to detect catch-all
                    probe = f"noexist-{random.randint(10000, 99999)}@{domain}"
                    code2, _ = smtp.rcpt(probe)
                    if code2 in (250, 251):
                        return "accept_all"
                    return "valid"
                if code in (550, 551, 552, 553, 554):
                    return "invalid"
                unknown_count += 1
        except (socket.timeout, smtplib.SMTPServerDisconnected, OSError) as e:
            log.debug("SMTP verify %s via %s: %s", email, mx, e)
            unknown_count += 1
        time.sleep(0.1)

    return "unknown" if unknown_count else "invalid"


def verify_smtp_batch(
    emails: list[str],
    *,
    stop_on_valid: bool = True,
) -> tuple[str | None, VerifyStatus]:
    """Verify in order; optional stop at first valid/accept_all."""
    for addr in emails:
        status = verify_smtp(addr)
        log.info("SMTP verify %s → %s", addr, status)
        if status in ("valid", "accept_all"):
            if stop_on_valid:
                return addr, status
        time.sleep(VERIFY_DELAY_SEC)
    return None, "invalid"
