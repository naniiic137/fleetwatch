"""HTTP endpoints: /metrics, /healthz, /readyz and / (JSON status)."""

from __future__ import annotations

import json
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .metrics import CONTENT_TYPE
from .service import ProbeService

log = logging.getLogger("fleetwatch.http")


class ProbeHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], service: ProbeService) -> None:
        self.service = service
        super().__init__(address, ProbeRequestHandler)


class ProbeRequestHandler(BaseHTTPRequestHandler):
    server: ProbeHTTPServer
    server_version = "fleetwatch-probe"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802 - name required by BaseHTTPRequestHandler
        self._dispatch(send_body=True)

    def do_HEAD(self) -> None:  # noqa: N802
        self._dispatch(send_body=False)

    def _dispatch(self, send_body: bool) -> None:
        service = self.server.service
        path = self.path.split("?", 1)[0]
        if path == "/metrics":
            self._send(200, CONTENT_TYPE, service.metrics.registry.render(), send_body)
        elif path == "/healthz":
            self._send(200, "text/plain; charset=utf-8", "ok\n", send_body)
        elif path == "/readyz":
            if service.ready.is_set() and not service.stopping.is_set():
                self._send(200, "text/plain; charset=utf-8", "ready\n", send_body)
            else:
                self._send(503, "text/plain; charset=utf-8", "not ready\n", send_body)
        elif path == "/":
            body = json.dumps(service.status(), indent=2) + "\n"
            self._send(200, "application/json", body, send_body)
        else:
            self._send(404, "application/json", '{"error": "not found"}\n', send_body)

    def _send(self, code: int, content_type: str, body: str, send_body: bool) -> None:
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if send_body:
            self.wfile.write(data)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        log.debug("http request", extra={"client": self.client_address[0], "line": format % args})


def make_server(service: ProbeService, host: str, port: int) -> ProbeHTTPServer:
    return ProbeHTTPServer((host, port), service)
