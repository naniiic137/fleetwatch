"""The probe loop: runs check rounds and keeps metrics and status up to date."""

from __future__ import annotations

import logging
import platform
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

from . import __version__
from .checker import CheckResult, check_target
from .config import Config
from .metrics import Registry
from .targets import Target

log = logging.getLogger("fleetwatch.service")

Checker = Callable[[Target], CheckResult]


class ProbeMetrics:
    """All metric families the probe exports."""

    def __init__(self) -> None:
        self.registry = Registry()
        r = self.registry
        self.build_info = r.gauge(
            "fleetwatch_probe_build_info",
            "Build information about the FleetWatch probe (always 1).",
            ("version", "python"),
        )
        self.up = r.gauge(
            "fleetwatch_probe_up",
            "1 if the last check of the target passed (status, keyword, TLS), else 0.",
            ("target", "url"),
        )
        self.status_code = r.gauge(
            "fleetwatch_probe_http_status_code",
            "HTTP status code of the last check (0 when no response was received).",
            ("target",),
        )
        self.duration = r.histogram(
            "fleetwatch_probe_duration_seconds",
            "Time from request start to the end of the body read, for checks that got a response.",
            ("target",),
        )
        self.cert_expiry = r.gauge(
            "fleetwatch_probe_tls_cert_expiry_days",
            "Days until the target's TLS certificate expires (https targets only).",
            ("target",),
        )
        self.last_check = r.gauge(
            "fleetwatch_probe_last_check_timestamp_seconds",
            "Unix time of the target's last completed check.",
            ("target",),
        )
        self.checks = r.counter(
            "fleetwatch_probe_checks_total",
            "Checks performed, by result.",
            ("target", "result"),
        )
        self.failures = r.counter(
            "fleetwatch_probe_check_failures_total",
            "Failed checks, by reason (status, keyword, timeout, dns, connection, tls, protocol).",
            ("target", "reason"),
        )
        self.rounds = r.counter(
            "fleetwatch_probe_rounds_total",
            "Completed probe rounds (one round checks every target once).",
        )
        self.round_duration = r.gauge(
            "fleetwatch_probe_round_duration_seconds",
            "Wall time the last probe round took.",
        )
        self.targets = r.gauge(
            "fleetwatch_probe_targets",
            "Number of configured targets.",
        )
        self.build_info.set(1, {"version": __version__, "python": platform.python_version()})

    def record(self, result: CheckResult) -> None:
        name = result.target
        self.up.set(1 if result.up else 0, {"target": name, "url": result.url})
        self.status_code.set(result.status_code or 0, {"target": name})
        if result.latency_seconds is not None:
            self.duration.observe(result.latency_seconds, {"target": name})
        if result.cert_days_left is not None:
            self.cert_expiry.set(round(result.cert_days_left, 3), {"target": name})
        self.last_check.set(round(result.checked_at, 3), {"target": name})
        self.checks.inc({"target": name, "result": "success" if result.up else "failure"})
        if result.reason is not None:
            self.failures.inc({"target": name, "reason": result.reason})


class ProbeService:
    def __init__(
        self,
        config: Config,
        targets: list[Target],
        checker: Checker | None = None,
    ) -> None:
        self.config = config
        self.targets = list(targets)
        self.metrics = ProbeMetrics()
        self.metrics.targets.set(len(self.targets))
        self.ready = threading.Event()
        self.stopping = threading.Event()
        self.started_at = time.time()
        self._lock = threading.Lock()
        self._results: dict[str, CheckResult] = {}
        self._rounds = 0
        self._last_round_at: float | None = None
        self._checker: Checker = checker or (
            lambda target: check_target(
                target, config.timeout_seconds, max_body_bytes=config.max_body_bytes
            )
        )
        self._executor = ThreadPoolExecutor(
            max_workers=min(config.concurrency, max(1, len(self.targets))),
            thread_name_prefix="probe",
        )

    def run_round(self) -> list[CheckResult]:
        started = time.monotonic()
        results = list(self._executor.map(self._safe_check, self.targets))
        for result in results:
            self.metrics.record(result)
            fields = {
                "target": result.target,
                "up": result.up,
                "status_code": result.status_code,
                "latency_ms": None
                if result.latency_seconds is None
                else round(result.latency_seconds * 1000, 1),
            }
            if result.reason:
                fields["reason"] = result.reason
                fields["error"] = result.error
                log.warning("check failed", extra=fields)
            else:
                log.debug("check ok", extra=fields)
        elapsed = time.monotonic() - started
        with self._lock:
            self._results = {r.target: r for r in results}
            self._rounds += 1
            self._last_round_at = time.time()
        self.metrics.rounds.inc()
        self.metrics.round_duration.set(round(elapsed, 4))
        up_count = sum(1 for r in results if r.up)
        log.info(
            "probe round complete",
            extra={"up": up_count, "down": len(results) - up_count, "seconds": round(elapsed, 3)},
        )
        if not self.ready.is_set():
            self.ready.set()
            log.info("ready")
        return results

    def _safe_check(self, target: Target) -> CheckResult:
        try:
            return self._checker(target)
        except Exception as exc:  # a checker bug must not kill the loop
            log.exception("checker crashed", extra={"target": target.name})
            return CheckResult(
                target=target.name,
                url=target.url,
                up=False,
                status_code=None,
                latency_seconds=None,
                cert_days_left=None,
                keyword_found=None,
                reason="protocol",
                error=f"internal error: {type(exc).__name__}",
                checked_at=time.time(),
            )

    def run_forever(self) -> None:
        log.info(
            "probe loop started",
            extra={"targets": len(self.targets), "interval_s": self.config.interval_seconds},
        )
        while not self.stopping.is_set():
            self.run_round()
            self.stopping.wait(self.config.interval_seconds)
        log.info("probe loop stopped")

    def stop(self) -> None:
        self.stopping.set()

    def close(self) -> None:
        self._executor.shutdown(wait=True, cancel_futures=True)

    def status(self) -> dict[str, object]:
        with self._lock:
            results = [self._results[t.name] for t in self.targets if t.name in self._results]
            rounds = self._rounds
            last_round_at = self._last_round_at
        return {
            "service": "fleetwatch-probe",
            "version": __version__,
            "ready": self.ready.is_set(),
            "rounds": rounds,
            "last_round_at": _iso(last_round_at),
            "interval_seconds": self.config.interval_seconds,
            "targets_total": len(self.targets),
            "targets_up": sum(1 for r in results if r.up),
            "targets": [dict(r.to_dict(), checked_at=_iso(r.checked_at)) for r in results],
        }


def _iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))
