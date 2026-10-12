"""
Probe the official EUIPO Trademark Search API.

This script does not store data. It verifies EUIPO API credentials, performs a
small search, and prints the fields needed for a future importer.

Required environment variables:
    EUIPO_CLIENT_ID
    EUIPO_CLIENT_SECRET

Optional environment variables:
    EUIPO_AUTH_URL   defaults to production OIDC token endpoint
    EUIPO_API_BASE   defaults to production Trademark Search API base

Example:
    EUIPO_CLIENT_ID=... EUIPO_CLIENT_SECRET=... \
        python scripts/euipo_search_probe.py --query "cat dad" --class 25
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


DEFAULT_AUTH_URL = "https://euipo.europa.eu/cas-server-webapp/oidc/accessToken"
DEFAULT_API_BASE = "https://api.euipo.europa.eu/trademark-search"


@dataclass(frozen=True)
class EuipoConfig:
    client_id: str
    client_secret: str
    auth_url: str
    api_base: str


class ProbeHttpError(RuntimeError):
    def __init__(self, stage: str, status: int, body: str) -> None:
        super().__init__(f"{stage} returned HTTP {status}")
        self.stage = stage
        self.status = status
        self.body = body


def require_config() -> EuipoConfig:
    client_id = os.environ.get("EUIPO_CLIENT_ID", "").strip()
    client_secret = os.environ.get("EUIPO_CLIENT_SECRET", "").strip()

    if not client_id or not client_secret:
        print(
            "ERROR: EUIPO_CLIENT_ID and EUIPO_CLIENT_SECRET must be set.",
            file=sys.stderr,
        )
        sys.exit(1)

    return EuipoConfig(
        client_id=client_id,
        client_secret=client_secret,
        auth_url=os.environ.get("EUIPO_AUTH_URL", DEFAULT_AUTH_URL).rstrip("/"),
        api_base=os.environ.get("EUIPO_API_BASE", DEFAULT_API_BASE).rstrip("/"),
    )


def http_json(req: Request, stage: str, timeout: int = 60) -> dict[str, Any]:
    try:
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise ProbeHttpError(stage, exc.code, body[:1200]) from exc
    except URLError as exc:
        print(f"Network error: {exc}", file=sys.stderr)
        raise


def get_access_token(config: EuipoConfig) -> str:
    body = urlencode(
        {
            "client_id": config.client_id,
            "client_secret": config.client_secret,
            "grant_type": "client_credentials",
            "scope": "uid",
        }
    ).encode("utf-8")

    req = Request(config.auth_url, data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    data = http_json(req, "token")
    token = data.get("access_token")
    if not isinstance(token, str) or not token:
        raise RuntimeError("EUIPO token response did not include access_token")
    return token


def escape_rsql_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def build_query(text: str, nice_class: int | None, status: str | None) -> str:
    parts = [f'wordMarkSpecification.verbalElement=="*{escape_rsql_value(text)}*"']
    if nice_class is not None:
        parts.append(f"niceClasses=all=({nice_class})")
    if status:
        parts.append(f"status=={status}")
    return " and ".join(parts)


def search_trademarks(
    config: EuipoConfig,
    token: str,
    query: str,
    page: int,
    size: int,
    raw: bool,
) -> dict[str, Any]:
    params = {
        "query": query,
        "page": str(page),
        "size": str(size),
    }

    if not raw:
        params["fields"] = (
            "trademarks(applicationNumber,markFeature,markKind,markBasis,"
            "niceClasses,wordMarkSpecification,status,applicationDate,"
            "registrationDate,expiryDate,applicants),page,size,totalElements,totalPages"
        )

    url = f"{config.api_base}/trademarks?{urlencode(params)}"
    req = Request(url, method="GET")
    req.add_header("Accept", "application/json")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("X-IBM-Client-Id", config.client_id)
    return http_json(req, "search")


def summarize(result: dict[str, Any]) -> None:
    print(
        json.dumps(
            {
                "page": result.get("page"),
                "size": result.get("size"),
                "totalElements": result.get("totalElements"),
                "totalPages": result.get("totalPages"),
            },
            indent=2,
        )
    )

    for item in result.get("trademarks", [])[:10]:
        wordmark = (item.get("wordMarkSpecification") or {}).get("verbalElement")
        applicants = item.get("applicants") or []
        first_applicant = applicants[0] if applicants else {}
        print(
            json.dumps(
                {
                    "applicationNumber": item.get("applicationNumber"),
                    "wordmark": wordmark,
                    "niceClasses": item.get("niceClasses"),
                    "status": item.get("status"),
                    "markFeature": item.get("markFeature"),
                    "applicationDate": item.get("applicationDate"),
                    "registrationDate": item.get("registrationDate"),
                    "owner": first_applicant.get("name"),
                },
                ensure_ascii=False,
            )
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Probe EUIPO Trademark Search API")
    parser.add_argument("--query", required=True, help="Wordmark text to search")
    parser.add_argument("--class", dest="nice_class", type=int, help="Nice class filter")
    parser.add_argument("--status", help="Optional EUIPO status filter, e.g. REGISTERED")
    parser.add_argument("--page", type=int, default=0, help="Zero-based result page")
    parser.add_argument("--size", type=int, default=10, help="Page size, max depends on EUIPO plan")
    parser.add_argument("--raw", action="store_true", help="Print the raw JSON response")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable probe status")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = require_config()
    query = build_query(args.query, args.nice_class, args.status)

    if not args.json:
        print(f"EUIPO query: {query}")

    token_ok = False
    try:
        token = get_access_token(config)
        token_ok = True
        result = search_trademarks(config, token, query, args.page, args.size, args.raw)
    except ProbeHttpError as exc:
        payload = {
            "ok": False,
            "stage": exc.stage,
            "token_ok": token_ok,
            "search_ok": False,
            "http_status": exc.status,
            "detail": exc.body,
        }
        if args.json:
            print(json.dumps(payload, indent=2, ensure_ascii=False))
        else:
            print(f"ERROR: EUIPO {exc.stage} probe returned HTTP {exc.status}: {exc.body}", file=sys.stderr)
        raise SystemExit(1) from None

    if args.json:
        print(
            json.dumps(
                {
                    "ok": True,
                    "stage": "search",
                    "token_ok": token_ok,
                    "search_ok": True,
                    "query": query,
                    "page": result.get("page"),
                    "size": result.get("size"),
                    "totalElements": result.get("totalElements"),
                    "totalPages": result.get("totalPages"),
                },
                indent=2,
                ensure_ascii=False,
            )
        )
        return

    if args.raw:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        summarize(result)


if __name__ == "__main__":
    main()
