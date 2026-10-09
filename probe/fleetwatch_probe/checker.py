"""One HTTP(S) check: status, latency, TLS certificate expiry and keyword."""

from __future__ import annotations

import http.client
import socket
import ssl
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from urllib.parse import urlsplit

from . import __version__
from .targets import Target

USER_AGENT = f"fleetwatch-probe/{__version__} (+https://github.com/naniiic137/fleetwatch)"

# Failure reasons, used as the "reason" label value. Kept to a small fixed set
# so label cardinality stays bounded.
REASONS = ("status", "keyword", "timeout", "dns", "connection", "tls", "protocol")


@dataclass(frozen=True)
class CheckResult:
    target: str
    url: str
    up: bool
    status_code: int | None
    latency_seconds: float | None
    cert_days_left: float | None
    keyword_found: bool | None
    reason: str | None
    error: str | None
    checked_at: float

    def to_dict(self) -> dict[str, object]:
        data = asdict(self)
        if data["latency_seconds"] is not None:
            data["latency_seconds"] = round(data["latency_seconds"], 4)
        if data["cert_days_left"] is not None:
            data["cert_days_left"] = round(data["cert_days_left"], 2)
        return data


def cert_days_left(not_after: str, now: float) -> float:
    """Days from ``now`` (epoch seconds) until an X.509 ``notAfter`` string."""
    return (ssl.cert_time_to_seconds(not_after) - now) / 86400.0


def check_target(
    target: Target,
    timeout: float,
    *,
    ssl_context: ssl.SSLContext | None = None,
    max_body_bytes: int = 1_048_576,
    clock: Callable[[], float] = time.perf_counter,
    wall_clock: Callable[[], float] = time.time,
) -> CheckResult:
    """Run one GET against ``target`` and return what happened. Never raises."""
    parts = urlsplit(target.url)
    host = parts.hostname or ""
    path = parts.path or "/"
    if parts.query:
        path = f"{path}?{parts.query}"
    is_https = parts.scheme == "https"

    status_code: int | None = None
    latency: float | None = None
    cert_days: float | None = None
    keyword_found: bool | None = None
    reason: str | None = None
    error: str | None = None

    if is_https:
        context = ssl_context or ssl.create_default_context()
        conn: http.client.HTTPConnection = http.client.HTTPSConnection(
            host, parts.port, timeout=timeout, context=context
        )
    else:
        conn = http.client.HTTPConnection(host, parts.port, timeout=timeout)

    start = clock()
    try:
        conn.request(
            "GET",
            path,
            headers={"User-Agent": USER_AGENT, "Accept": "*/*", "Connection": "close"},
        )
        response = conn.getresponse()
        status_code = response.status
        if is_https and conn.sock is not None:
            cert = conn.sock.getpeercert()
            if cert and cert.get("notAfter"):
                cert_days = cert_days_left(str(cert["notAfter"]), wall_clock())
        body = response.read(max_body_bytes)
        latency = clock() - start

        if status_code != target.expect_status:
            reason = "status"
            error = f"expected status {target.expect_status}, got {status_code}"
        if target.expect_keyword is not None:
            keyword_found = target.expect_keyword in body.decode("utf-8", errors="replace")
            if not keyword_found and reason is None:
                reason = "keyword"
                error = f"keyword {target.expect_keyword!r} not found"
    except ssl.SSLCertVerificationError as exc:
        reason, error = "tls", f"certificate verification failed: {exc.verify_message}"
    except ssl.SSLError as exc:
        reason, error = "tls", f"TLS error: {exc.reason or exc}"
    except TimeoutError:
        reason, error = "timeout", f"no response within {timeout:g}s"
    except socket.gaierror as exc:
        reason, error = "dns", f"DNS lookup failed: {exc.strerror or exc}"
    except OSError as exc:
        reason, error = "connection", f"connection failed: {exc.strerror or exc}"
    except http.client.HTTPException as exc:
        reason, error = "protocol", f"HTTP protocol error: {type(exc).__name__}"
    finally:
        conn.close()

    return CheckResult(
        target=target.name,
        url=target.url,
        up=reason is None,
        status_code=status_code,
        latency_seconds=latency,
        cert_days_left=cert_days,
        keyword_found=keyword_found,
        reason=reason,
        error=error,
        checked_at=wall_clock(),
    )
