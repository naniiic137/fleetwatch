"""Entry point: ``python -m fleetwatch_probe``."""

from __future__ import annotations

import logging
import signal
import sys
import threading

from . import __version__
from .config import Config, ConfigError
from .logjson import setup_logging
from .server import make_server
from .service import ProbeService
from .targets import TargetsError, load_targets


def main() -> int:
    try:
        config = Config.from_env()
    except ConfigError as exc:
        setup_logging("INFO")
        logging.getLogger("fleetwatch").error("invalid configuration", extra={"error": str(exc)})
        return 2

    log = setup_logging(config.log_level)
    try:
        targets = load_targets(config.targets_file)
    except (OSError, TargetsError) as exc:
        log.error(
            "cannot load targets", extra={"file": config.targets_file, "error": str(exc)}
        )
        return 2

    service = ProbeService(config, targets)
    server = make_server(service, config.listen_host, config.port)
    host, port = server.server_address[:2]
    http_thread = threading.Thread(target=server.serve_forever, name="http", daemon=True)
    http_thread.start()
    log.info(
        "fleetwatch probe started",
        extra={"version": __version__, "host": host, "port": port, "targets": len(targets)},
    )

    def handle_signal(signum: int, _frame: object) -> None:
        log.info("shutdown requested", extra={"signal": signal.Signals(signum).name})
        service.stop()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    try:
        service.run_forever()
    finally:
        server.shutdown()
        server.server_close()
        service.close()
        log.info("fleetwatch probe stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
