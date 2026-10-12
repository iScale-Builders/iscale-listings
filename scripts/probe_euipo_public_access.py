"""
Probe public EUIPO trademark API/source-access metadata.

This checks official EUIPO public pages only. It does not authenticate, store
credentials, or call the Trademark Search API.

Examples:
    python scripts/probe_euipo_public_access.py
    python scripts/probe_euipo_public_access.py --json
"""

from __future__ import annotations

import argparse
import html
import json
import re
from dataclasses import asdict, dataclass
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


GETTING_STARTED_URL = "https://dev.euipo.europa.eu/getting-started"
STATISTICS_URL = "https://www.euipo.europa.eu/en/about-us/the-office/what-we-do/statistics"
EUTM_30_YEARS_URL = (
    "https://www.euipo.europa.eu/en/news/"
    "eu-trade-mark-system-marks-30-years-with-more-than-3-2-million-applications-filed"
)


@dataclass(frozen=True)
class EuipoPublicProbeResult:
    getting_started_url: str
    getting_started_reachable: bool
    getting_started_error: str | None
    account_required: bool
    app_registration_required: bool
    client_credentials_mentioned: bool
    api_subscription_required: bool
    sandbox_available: bool
    subscription_approval_mentioned: bool
    statistics_url: str
    statistics_reachable: bool
    statistics_error: str | None
    statistics_updated_on: str | None
    statistics_cadence: str | None
    eutm_news_url: str
    eutm_news_reachable: bool
    eutm_news_error: str | None
    applications_by_february_2026: str | None
    current_coverage_usable: bool
    source_access_path: str


def fetch_text(url: str) -> tuple[int, str, str | None]:
    req = Request(
        url,
        headers={
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Encoding": "identity",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            "Connection": "close",
            "User-Agent": "Mozilla/5.0",
        },
        method="GET",
    )
    try:
        with urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace"), None
    except HTTPError as exc:
        return exc.code, "", f"HTTP Error {exc.code}: {exc.reason}"
    except (TimeoutError, URLError) as exc:
        return 0, "", str(exc)


def clean_html(value: str | None) -> str:
    if not value:
        return ""
    value = re.sub(r"<[^>]+>", " ", value)
    value = html.unescape(value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def has_text(plain: str, *parts: str) -> bool:
    lowered = plain.lower()
    return all(part.lower() in lowered for part in parts)


def first_match(plain: str, pattern: str) -> str | None:
    match = re.search(pattern, plain, flags=re.IGNORECASE)
    if not match:
        return None
    return re.sub(r"\s+", " ", match.group(1)).strip()


def run_probe(
    getting_started_url: str,
    statistics_url: str,
    eutm_news_url: str,
) -> EuipoPublicProbeResult:
    getting_status, getting_text, getting_error = fetch_text(getting_started_url)
    stats_status, stats_text, stats_error = fetch_text(statistics_url)
    news_status, news_text, news_error = fetch_text(eutm_news_url)

    getting_plain = clean_html(getting_text)
    stats_plain = clean_html(stats_text)
    news_plain = clean_html(news_text)

    return EuipoPublicProbeResult(
        getting_started_url=getting_started_url,
        getting_started_reachable=getting_status == 200,
        getting_started_error=getting_error,
        account_required=has_text(getting_plain, "To access our APIs", "EUIPO account"),
        app_registration_required=has_text(getting_plain, "Register your application", "Apps"),
        client_credentials_mentioned=has_text(getting_plain, "Client ID", "Client Secret"),
        api_subscription_required=has_text(getting_plain, "Subscribe to APIs", "request a subscription"),
        sandbox_available=has_text(getting_plain, "Sandbox", "Production", "same APIs"),
        subscription_approval_mentioned=has_text(getting_plain, "subject to approval"),
        statistics_url=statistics_url,
        statistics_reachable=stats_status == 200,
        statistics_error=stats_error,
        statistics_updated_on=first_match(stats_plain, r"Updated on\s+([0-9]{2}/[0-9]{2}/[0-9]{4})"),
        statistics_cadence=first_match(stats_plain, r"(Updates are generally applied on a regular monthly basis)"),
        eutm_news_url=eutm_news_url,
        eutm_news_reachable=news_status == 200,
        eutm_news_error=news_error,
        applications_by_february_2026=first_match(news_plain, r"reaching\s+([0-9 ]{7,})\s+by February 2026"),
        current_coverage_usable=False,
        source_access_path=(
            "Create/sign in to an EUIPO API Portal account, register an app, subscribe to "
            "Trademark Search, then save EUIPO_CLIENT_ID and EUIPO_CLIENT_SECRET or an "
            "official EUIPO_DELIVERY_PATH in the central credentials vault."
        ),
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Probe public EUIPO source-access metadata")
    parser.add_argument("--getting-started-url", default=GETTING_STARTED_URL)
    parser.add_argument("--statistics-url", default=STATISTICS_URL)
    parser.add_argument("--eutm-news-url", default=EUTM_30_YEARS_URL)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    result = run_probe(args.getting_started_url, args.statistics_url, args.eutm_news_url)
    if args.json:
        print(json.dumps(asdict(result), indent=2))
        return
    print(f"Getting started reachable: {result.getting_started_reachable}")
    print(f"Account required: {result.account_required}")
    print(f"App registration required: {result.app_registration_required}")
    print(f"Client credentials mentioned: {result.client_credentials_mentioned}")
    print(f"API subscription required: {result.api_subscription_required}")
    print(f"Sandbox available: {result.sandbox_available}")
    print(f"Statistics updated on: {result.statistics_updated_on or '-'}")
    print(f"Statistics cadence: {result.statistics_cadence or '-'}")
    print(f"Applications by February 2026: {result.applications_by_february_2026 or '-'}")
    print(f"Current coverage usable: {result.current_coverage_usable}")
    print(f"Source access path: {result.source_access_path}")


if __name__ == "__main__":
    main()
