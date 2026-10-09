"""Configuration from environment variables."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass


class ConfigError(ValueError):
    """Raised when an environment variable has an invalid value."""


LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR")


@dataclass(frozen=True)
class Config:
    targets_file: str = "targets.yaml"
    listen_host: str = "0.0.0.0"
    port: int = 8080
    interval_seconds: float = 30.0
    timeout_seconds: float = 10.0
    concurrency: int = 8
    max_body_bytes: int = 1_048_576
    log_level: str = "INFO"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Config:
        env = os.environ if env is None else env
        defaults = cls()
        log_level = env.get("FW_LOG_LEVEL", defaults.log_level).strip().upper()
        if log_level not in LOG_LEVELS:
            raise ConfigError(f"FW_LOG_LEVEL must be one of {', '.join(LOG_LEVELS)}")
        return cls(
            targets_file=env.get("FW_TARGETS_FILE", defaults.targets_file),
            listen_host=env.get("FW_LISTEN_HOST", defaults.listen_host),
            port=_int(env, "FW_PORT", defaults.port, minimum=0, maximum=65535),
            interval_seconds=_float(env, "FW_INTERVAL_SECONDS", defaults.interval_seconds, 1.0),
            timeout_seconds=_float(env, "FW_TIMEOUT_SECONDS", defaults.timeout_seconds, 0.1),
            concurrency=_int(env, "FW_CONCURRENCY", defaults.concurrency, minimum=1, maximum=64),
            max_body_bytes=_int(
                env, "FW_MAX_BODY_BYTES", defaults.max_body_bytes, minimum=1024, maximum=16_777_216
            ),
            log_level=log_level,
        )


def _int(env: Mapping[str, str], key: str, default: int, minimum: int, maximum: int) -> int:
    raw = env.get(key)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw.strip())
    except ValueError as exc:
        raise ConfigError(f"{key} must be an integer, got {raw!r}") from exc
    if not minimum <= value <= maximum:
        raise ConfigError(f"{key} must be between {minimum} and {maximum}, got {value}")
    return value


def _float(env: Mapping[str, str], key: str, default: float, minimum: float) -> float:
    raw = env.get(key)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw.strip())
    except ValueError as exc:
        raise ConfigError(f"{key} must be a number, got {raw!r}") from exc
    if value != value or value < minimum or value == float("inf"):
        raise ConfigError(f"{key} must be a finite number >= {minimum}, got {raw!r}")
    return value
