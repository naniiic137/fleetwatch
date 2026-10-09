"""A local fake HTTP(S) server for tests. Nothing in the test suite touches the real network."""

from __future__ import annotations

import os
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    routes = {
        "/ok": (200, "<html><title>FleetWatch test page</title>hello fleetwatch</html>"),
        "/error": (500, "boom"),
        "/redirect": (301, "moved"),
    }

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/slow":
            time.sleep(1.5)
            code, body = 200, "finally"
        elif self.path == "/garbage":
            self.wfile.write(b"this is not http\r\n\r\n")
            self.wfile.flush()
            self.close_connection = True
            return
        else:
            code, body = self.routes.get(self.path, (404, "not found"))
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        if code == 301:
            self.send_header("Location", "/ok")
        self.end_headers()
        try:
            self.wfile.write(data)
        except OSError:
            pass  # the client timed out and went away

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass


class FakeServer:
    """Runs FakeHandler on 127.0.0.1 on a random free port."""

    def __init__(self, ssl_context: ssl.SSLContext | None = None) -> None:
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), FakeHandler)
        self.httpd.daemon_threads = True
        if ssl_context is not None:
            self.httpd.socket = ssl_context.wrap_socket(self.httpd.socket, server_side=True)
        self.scheme = "https" if ssl_context else "http"
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def url(self, path: str) -> str:
        return f"{self.scheme}://127.0.0.1:{self.port}{path}"

    def __enter__(self) -> FakeServer:
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def make_self_signed_cert(directory: str, days: int = 30) -> tuple[str, str] | None:
    """Create a self-signed cert for 127.0.0.1 with the openssl CLI, or None if unavailable."""
    openssl = shutil.which("openssl")
    if not openssl:
        return None
    cert = os.path.join(directory, "cert.pem")
    key = os.path.join(directory, "key.pem")
    cmd = [
        openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", key, "-out", cert, "-days", str(days),
        "-subj", "/CN=127.0.0.1",
        "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ]  # fmt: skip
    env = dict(os.environ, MSYS_NO_PATHCONV="1")
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=60, env=env)
    except (OSError, subprocess.SubprocessError):
        return None
    return cert, key


def free_port() -> int:
    """A port that nothing listens on (bound, then released)."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def temp_dir() -> tempfile.TemporaryDirectory:
    return tempfile.TemporaryDirectory(prefix="fleetwatch-test-")
