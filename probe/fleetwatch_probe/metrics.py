"""A small, hand-written Prometheus metrics registry.

Renders the Prometheus text exposition format, version 0.0.4:
https://prometheus.io/docs/instrumenting/exposition_formats/

Every family gets ``# HELP`` and ``# TYPE`` lines, label values are escaped,
histogram buckets are cumulative and end with ``le="+Inf"``, followed by
``_sum`` and ``_count``.
"""

from __future__ import annotations

import math
import re
import threading
from collections.abc import Iterable, Sequence

CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"

METRIC_NAME_RE = re.compile(r"^[a-zA-Z_:][a-zA-Z0-9_:]*$")
LABEL_NAME_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")

DEFAULT_BUCKETS = (0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0)


def format_value(value: float) -> str:
    """Format a sample value the way Prometheus parses it."""
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "+Inf" if value > 0 else "-Inf"
    if float(value).is_integer() and abs(value) < 1e15:
        return str(int(value))
    return repr(float(value))


def escape_label_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def escape_help(text: str) -> str:
    return text.replace("\\", "\\\\").replace("\n", "\\n")


def format_labels(names: Sequence[str], values: Sequence[str]) -> str:
    if not names:
        return ""
    pairs = ",".join(
        f'{name}="{escape_label_value(value)}"' for name, value in zip(names, values, strict=True)
    )
    return "{" + pairs + "}"


class _Metric:
    kind = "untyped"

    def __init__(self, name: str, documentation: str, labelnames: Iterable[str] = ()) -> None:
        if not METRIC_NAME_RE.match(name):
            raise ValueError(f"invalid metric name {name!r}")
        self.name = name
        self.documentation = documentation
        self.labelnames = tuple(labelnames)
        for label in self.labelnames:
            if not LABEL_NAME_RE.match(label) or label.startswith("__"):
                raise ValueError(f"invalid label name {label!r}")
        self._lock = threading.Lock()

    def _key(self, labels: dict[str, str] | None) -> tuple[str, ...]:
        labels = labels or {}
        if set(labels) != set(self.labelnames):
            raise ValueError(
                f"{self.name}: expected labels {sorted(self.labelnames)}, got {sorted(labels)}"
            )
        return tuple(str(labels[name]) for name in self.labelnames)

    def header(self) -> list[str]:
        return [
            f"# HELP {self.name} {escape_help(self.documentation)}",
            f"# TYPE {self.name} {self.kind}",
        ]

    def samples(self) -> list[str]:  # pragma: no cover - overridden
        raise NotImplementedError

    def render(self) -> list[str]:
        return self.header() + self.samples()


class Counter(_Metric):
    """A monotonically increasing counter. The name must end with ``_total``."""

    kind = "counter"

    def __init__(self, name: str, documentation: str, labelnames: Iterable[str] = ()) -> None:
        if not name.endswith("_total"):
            raise ValueError("counter names must end with _total")
        super().__init__(name, documentation, labelnames)
        self._values: dict[tuple[str, ...], float] = {}

    def inc(self, labels: dict[str, str] | None = None, amount: float = 1.0) -> None:
        if amount < 0:
            raise ValueError("counters can only increase")
        key = self._key(labels)
        with self._lock:
            self._values[key] = self._values.get(key, 0.0) + amount

    def get(self, labels: dict[str, str] | None = None) -> float:
        with self._lock:
            return self._values.get(self._key(labels), 0.0)

    def samples(self) -> list[str]:
        with self._lock:
            items = sorted(self._values.items())
        return [
            f"{self.name}{format_labels(self.labelnames, key)} {format_value(value)}"
            for key, value in items
        ]


class Gauge(_Metric):
    """A value that can go up and down."""

    kind = "gauge"

    def __init__(self, name: str, documentation: str, labelnames: Iterable[str] = ()) -> None:
        super().__init__(name, documentation, labelnames)
        self._values: dict[tuple[str, ...], float] = {}

    def set(self, value: float, labels: dict[str, str] | None = None) -> None:
        key = self._key(labels)
        with self._lock:
            self._values[key] = float(value)

    def get(self, labels: dict[str, str] | None = None) -> float | None:
        with self._lock:
            return self._values.get(self._key(labels))

    def remove(self, labels: dict[str, str] | None = None) -> None:
        key = self._key(labels)
        with self._lock:
            self._values.pop(key, None)

    def samples(self) -> list[str]:
        with self._lock:
            items = sorted(self._values.items())
        return [
            f"{self.name}{format_labels(self.labelnames, key)} {format_value(value)}"
            for key, value in items
        ]


class Histogram(_Metric):
    """Counts observations into cumulative ``le`` buckets."""

    kind = "histogram"

    def __init__(
        self,
        name: str,
        documentation: str,
        labelnames: Iterable[str] = (),
        buckets: Sequence[float] = DEFAULT_BUCKETS,
    ) -> None:
        super().__init__(name, documentation, labelnames)
        if "le" in self.labelnames:
            raise ValueError("'le' is reserved for histogram buckets")
        bounds = sorted(float(b) for b in buckets if not math.isinf(b))
        if not bounds or len(set(bounds)) != len(bounds):
            raise ValueError("histogram buckets must be non-empty and unique")
        self.buckets = tuple(bounds)
        # Per label set: [non-cumulative counts per bucket (+Inf last), sum, count]
        self._data: dict[tuple[str, ...], tuple[list[int], list[float]]] = {}

    def observe(self, value: float, labels: dict[str, str] | None = None) -> None:
        key = self._key(labels)
        with self._lock:
            counts, totals = self._data.setdefault(key, ([0] * (len(self.buckets) + 1), [0.0, 0]))
            for index, bound in enumerate(self.buckets):
                if value <= bound:
                    counts[index] += 1
                    break
            else:
                counts[-1] += 1
            totals[0] += value
            totals[1] += 1

    def snapshot(self, labels: dict[str, str] | None = None) -> tuple[list[int], float, int]:
        """Return (cumulative bucket counts incl. +Inf, sum, count)."""
        key = self._key(labels)
        with self._lock:
            counts, totals = self._data.get(key, ([0] * (len(self.buckets) + 1), [0.0, 0]))
            cumulative = []
            running = 0
            for count in counts:
                running += count
                cumulative.append(running)
            return cumulative, totals[0], int(totals[1])

    def samples(self) -> list[str]:
        with self._lock:
            keys = sorted(self._data)
        lines: list[str] = []
        bucket_labels = (*self.labelnames, "le")
        for key in keys:
            labels = dict(zip(self.labelnames, key, strict=True))
            cumulative, total, count = self.snapshot(labels)
            bounds = [format_value(b) for b in self.buckets] + ["+Inf"]
            for bound, value in zip(bounds, cumulative, strict=True):
                lines.append(
                    f"{self.name}_bucket{format_labels(bucket_labels, (*key, bound))} {value}"
                )
            plain = format_labels(self.labelnames, key)
            lines.append(f"{self.name}_sum{plain} {format_value(total)}")
            lines.append(f"{self.name}_count{plain} {count}")
        return lines


class Registry:
    def __init__(self) -> None:
        self._metrics: list[_Metric] = []
        self._names: set[str] = set()

    def register(self, metric: _Metric) -> _Metric:
        if metric.name in self._names:
            raise ValueError(f"duplicate metric {metric.name}")
        self._names.add(metric.name)
        self._metrics.append(metric)
        return metric

    def counter(self, name: str, documentation: str, labelnames: Iterable[str] = ()) -> Counter:
        metric = Counter(name, documentation, labelnames)
        self.register(metric)
        return metric

    def gauge(self, name: str, documentation: str, labelnames: Iterable[str] = ()) -> Gauge:
        metric = Gauge(name, documentation, labelnames)
        self.register(metric)
        return metric

    def histogram(
        self,
        name: str,
        documentation: str,
        labelnames: Iterable[str] = (),
        buckets: Sequence[float] = DEFAULT_BUCKETS,
    ) -> Histogram:
        metric = Histogram(name, documentation, labelnames, buckets)
        self.register(metric)
        return metric

    def render(self) -> str:
        lines: list[str] = []
        for metric in self._metrics:
            lines.extend(metric.render())
        return "\n".join(lines) + "\n"
