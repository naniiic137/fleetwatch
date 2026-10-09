"""Load targets from a small, documented subset of YAML.

The probe has no third-party dependencies, so instead of PyYAML it parses the
subset FleetWatch uses: comments, one top-level ``targets:`` key holding a list
of flat mappings, and plain, single-quoted or double-quoted scalar values.
Both hand-written files and Helm's ``toYaml`` output fit this subset.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from urllib.parse import urlsplit

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$")
KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*:(?:\s+(.*))?$")
KNOWN_KEYS = {"name", "url", "expect_status", "expect_keyword"}


class TargetsError(ValueError):
    """Raised for a malformed targets file."""


@dataclass(frozen=True)
class Target:
    name: str
    url: str
    expect_status: int = 200
    expect_keyword: str | None = None


def parse_scalar(raw: str, lineno: int) -> str | int | bool | None:
    """Parse one scalar value: quoted string, int, bool, null or plain string."""
    raw = raw.strip()
    if raw.startswith('"'):
        end = _closing_double_quote(raw)
        if end == -1:
            raise TargetsError(f"line {lineno}: unterminated double-quoted string")
        _expect_only_comment(raw[end + 1 :], lineno)
        try:
            return json.loads(raw[: end + 1])
        except json.JSONDecodeError as exc:
            raise TargetsError(f"line {lineno}: bad escape in quoted string") from exc
    if raw.startswith("'"):
        i = 1
        out = []
        while i < len(raw):
            ch = raw[i]
            if ch == "'":
                if raw[i + 1 : i + 2] == "'":
                    out.append("'")
                    i += 2
                    continue
                _expect_only_comment(raw[i + 1 :], lineno)
                return "".join(out)
            out.append(ch)
            i += 1
        raise TargetsError(f"line {lineno}: unterminated single-quoted string")
    # Plain scalar: a comment starts at " #" (or the value is only a comment).
    if raw.startswith("#"):
        return None
    hash_at = raw.find(" #")
    if hash_at != -1:
        raw = raw[:hash_at].rstrip()
    if raw in ("", "~", "null", "Null", "NULL"):
        return None
    if raw in ("true", "True", "TRUE"):
        return True
    if raw in ("false", "False", "FALSE"):
        return False
    if re.fullmatch(r"[-+]?[0-9]+", raw):
        return int(raw)
    if raw[0] in "[{&*!|>%@`":
        raise TargetsError(f"line {lineno}: unsupported YAML syntax {raw!r}")
    return raw


def _closing_double_quote(raw: str) -> int:
    i = 1
    while i < len(raw):
        if raw[i] == "\\":
            i += 2
            continue
        if raw[i] == '"':
            return i
        i += 1
    return -1


def _expect_only_comment(rest: str, lineno: int) -> None:
    rest = rest.strip()
    if rest and not rest.startswith("#"):
        raise TargetsError(f"line {lineno}: unexpected text after quoted string: {rest!r}")


def parse_targets(text: str) -> list[Target]:
    """Parse the targets document and return validated targets."""
    items: list[dict[str, object]] = []
    current: dict[str, object] | None = None
    in_targets = False
    seen_targets_key = False

    for lineno, line in enumerate(text.splitlines(), start=1):
        if "\t" in line[: len(line) - len(line.lstrip())]:
            raise TargetsError(f"line {lineno}: tabs are not allowed for indentation")
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped == "---":
            continue
        indent = len(line) - len(line.lstrip(" "))

        if stripped == "-" or stripped.startswith("- "):
            if not in_targets:
                raise TargetsError(f"line {lineno}: list item outside 'targets:'")
            current = {}
            items.append(current)
            rest = stripped[1:].strip()
            if rest:
                _put(current, rest, lineno)
            continue

        if indent == 0:
            match = KEY_RE.match(stripped)
            if not match:
                raise TargetsError(f"line {lineno}: expected 'key: value'")
            key, value = match.group(1), match.group(2)
            if key != "targets":
                raise TargetsError(f"line {lineno}: unknown top-level key {key!r}")
            inline = (value or "").strip()
            inline = "" if inline.startswith("#") else inline.split(" #", 1)[0].strip()
            if inline not in ("", "[]"):
                raise TargetsError(f"line {lineno}: 'targets:' must be followed by a list")
            in_targets = True
            seen_targets_key = True
            current = None
            continue

        if current is None:
            raise TargetsError(f"line {lineno}: mapping key outside a list item")
        _put(current, stripped, lineno)

    if not seen_targets_key:
        raise TargetsError("missing top-level 'targets:' key")
    return validate(items)


def _put(item: dict[str, object], text: str, lineno: int) -> None:
    match = KEY_RE.match(text)
    if not match:
        raise TargetsError(f"line {lineno}: expected 'key: value', got {text!r}")
    key, value = match.group(1), match.group(2)
    if key in item:
        raise TargetsError(f"line {lineno}: duplicate key {key!r}")
    item[key] = parse_scalar(value, lineno) if value is not None else None


def validate(items: list[dict[str, object]]) -> list[Target]:
    targets: list[Target] = []
    names: set[str] = set()
    for index, item in enumerate(items, start=1):
        unknown = set(item) - KNOWN_KEYS
        if unknown:
            raise TargetsError(f"target #{index}: unknown keys {sorted(unknown)}")
        name = item.get("name")
        if not isinstance(name, str) or not NAME_RE.match(name):
            raise TargetsError(
                f"target #{index}: 'name' must match {NAME_RE.pattern} (got {name!r})"
            )
        if name in names:
            raise TargetsError(f"target #{index}: duplicate name {name!r}")
        names.add(name)

        url = item.get("url")
        if not isinstance(url, str):
            raise TargetsError(f"target {name!r}: 'url' is required")
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise TargetsError(f"target {name!r}: 'url' must be an http(s) URL")

        status = item.get("expect_status", 200)
        if status is None:
            status = 200
        if isinstance(status, bool) or not isinstance(status, int) or not 100 <= status <= 599:
            raise TargetsError(f"target {name!r}: 'expect_status' must be 100-599")

        keyword = item.get("expect_keyword")
        if keyword is not None and not isinstance(keyword, str):
            keyword = str(keyword)
        if keyword == "":
            keyword = None

        targets.append(Target(name=name, url=url, expect_status=status, expect_keyword=keyword))
    if not targets:
        raise TargetsError("no targets defined")
    return targets


def load_targets(path: str) -> list[Target]:
    with open(path, encoding="utf-8") as handle:
        return parse_targets(handle.read())
