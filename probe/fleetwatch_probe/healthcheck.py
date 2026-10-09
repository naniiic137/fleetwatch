"""Container HEALTHCHECK: ``python -m fleetwatch_probe.healthcheck`` (exit 0 = healthy).

The slim base image has no curl or wget, so the check uses urllib.
"""

from __future__ import annotations

import os
import sys
import urllib.request


def main() -> int:
    port = os.environ.get("FW_PORT", "8080")
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=3) as response:
            return 0 if response.status == 200 else 1
    except OSError:
        return 1


if __name__ == "__main__":
    sys.exit(main())
