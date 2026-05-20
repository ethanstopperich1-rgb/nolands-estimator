"""CloakBrowser helpers — DBPR download + site scraping behind bot checks."""

from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Iterator

from config import USER_AGENT

log = logging.getLogger("contractor_intel.browser")


def cloakbrowser_available() -> bool:
    try:
        import cloakbrowser  # noqa: F401

        return True
    except ImportError:
        return False


@contextmanager
def browser_session(*, headless: bool = True) -> Iterator:
    """Launch CloakBrowser (stealth Chromium)."""
    try:
        from cloakbrowser import launch
    except ImportError as e:
        raise RuntimeError(
            "cloakbrowser not installed. Run: pip install -r "
            "scripts/requirements-contractor-intel.txt\n"
            "Or: pip install git+https://github.com/CloakHQ/CloakBrowser.git"
        ) from e

    log.info("Launching CloakBrowser (first run may download ~200MB)…")
    with launch(headless=headless, humanize=True) as browser:
        context = browser.new_context(user_agent=USER_AGENT)
        page = context.new_page()
        try:
            yield page
        finally:
            context.close()


def fetch_url_bytes(page, url: str, *, timeout_ms: int = 90_000) -> bytes:
    """GET a URL via the browser; returns response body as bytes."""
    response = page.goto(url, wait_until="commit", timeout=timeout_ms)
    if response is None:
        raise RuntimeError(f"No response for {url}")
    if response.status >= 400:
        raise RuntimeError(f"HTTP {response.status} for {url}")
    return response.body()


def fetch_page_text(page, url: str, *, settle_ms: int = 1500) -> str:
    """Navigate and return visible body text (for HTML pages)."""
    page.goto(url, wait_until="domcontentloaded", timeout=60_000)
    if settle_ms > 0:
        page.wait_for_timeout(settle_ms)
    return page.locator("body").inner_text()[:80_000]


def fetch_page_html(page, url: str, *, settle_ms: int = 1500) -> str:
    page.goto(url, wait_until="domcontentloaded", timeout=60_000)
    if settle_ms > 0:
        page.wait_for_timeout(settle_ms)
    return page.content()
