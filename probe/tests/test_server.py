import json
import threading
import time
import unittest
import urllib.error
import urllib.request

from fleetwatch_probe.checker import CheckResult
from fleetwatch_probe.config import Config
from fleetwatch_probe.server import make_server
from fleetwatch_probe.service import ProbeService
from fleetwatch_probe.targets import Target

from .fakes import FakeServer
from .test_metrics import assert_valid_exposition


def fake_result(target, up=True, latency=0.2, cert=45.5, reason=None):
    return CheckResult(
        target=target.name,
        url=target.url,
        up=up,
        status_code=200 if up else 503,
        latency_seconds=latency,
        cert_days_left=cert,
        keyword_found=None,
        reason=reason,
        error=None if up else "expected status 200, got 503",
        checked_at=1_700_000_000.0,
    )


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.targets = [
            Target("alpha", "https://alpha.example"),
            Target("beta", "https://beta.example"),
        ]

        def checker(target):
            if target.name == "alpha":
                return fake_result(target)
            return fake_result(target, up=False, reason="status")

        self.service = ProbeService(Config(), self.targets, checker=checker)
        self.httpd = make_server(self.service, "127.0.0.1", 0)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.service.close()

    def get(self, path):
        url = f"http://127.0.0.1:{self.port}{path}"
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                return response.status, response.headers, response.read().decode()
        except urllib.error.HTTPError as err:
            return err.code, err.headers, err.read().decode()

    def test_healthz_always_ok(self):
        self.assertEqual(self.get("/healthz")[0], 200)

    def test_readyz_after_first_round(self):
        self.assertEqual(self.get("/readyz")[0], 503)
        self.service.run_round()
        self.assertEqual(self.get("/readyz")[0], 200)
        self.service.stop()
        self.assertEqual(self.get("/readyz")[0], 503)  # draining during shutdown

    def test_status_json(self):
        status, headers, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertFalse(json.loads(body)["ready"])
        self.service.run_round()
        data = json.loads(self.get("/")[2])
        self.assertTrue(data["ready"])
        self.assertEqual(data["rounds"], 1)
        self.assertEqual((data["targets_total"], data["targets_up"]), (2, 1))
        self.assertEqual([t["target"] for t in data["targets"]], ["alpha", "beta"])
        self.assertEqual(data["targets"][1]["reason"], "status")
        self.assertEqual(data["targets"][0]["checked_at"], "2023-11-14T22:13:20Z")

    def test_metrics(self):
        self.service.run_round()
        self.service.run_round()
        status, headers, body = self.get("/metrics")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/plain; version=0.0.4; charset=utf-8")
        assert_valid_exposition(self, body)
        expected_lines = [
            "# TYPE fleetwatch_probe_up gauge",
            'fleetwatch_probe_up{target="alpha",url="https://alpha.example"} 1',
            'fleetwatch_probe_up{target="beta",url="https://beta.example"} 0',
            "# TYPE fleetwatch_probe_duration_seconds histogram",
            'fleetwatch_probe_duration_seconds_bucket{target="alpha",le="0.25"} 2',
            'fleetwatch_probe_duration_seconds_bucket{target="alpha",le="0.1"} 0',
            'fleetwatch_probe_duration_seconds_bucket{target="alpha",le="+Inf"} 2',
            'fleetwatch_probe_duration_seconds_count{target="alpha"} 2',
            'fleetwatch_probe_tls_cert_expiry_days{target="alpha"} 45.5',
            'fleetwatch_probe_checks_total{target="alpha",result="success"} 2',
            'fleetwatch_probe_checks_total{target="beta",result="failure"} 2',
            'fleetwatch_probe_check_failures_total{target="beta",reason="status"} 2',
            'fleetwatch_probe_http_status_code{target="beta"} 503',
            "fleetwatch_probe_rounds_total 2",
            "fleetwatch_probe_targets 2",
        ]
        lines = body.splitlines()
        for line in expected_lines:
            self.assertIn(line, lines)

    def test_head_and_404(self):
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}/healthz", method="HEAD")
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), b"")
        self.assertEqual(self.get("/nope")[0], 404)


class ServiceTest(unittest.TestCase):
    def test_crashing_checker_is_reported_as_down(self):
        def checker(_target):
            raise RuntimeError("bug")

        service = ProbeService(Config(), [Target("x", "https://x.example")], checker=checker)
        try:
            with self.assertLogs("fleetwatch.service", level="ERROR"):
                results = service.run_round()
        finally:
            service.close()
        self.assertFalse(results[0].up)
        self.assertTrue(service.ready.is_set())

    def test_run_forever_stops_promptly(self):
        service = ProbeService(
            Config(interval_seconds=60),
            [Target("x", "https://x.example")],
            checker=lambda t: fake_result(t),
        )
        thread = threading.Thread(target=service.run_forever)
        started = time.monotonic()
        thread.start()
        self.assertTrue(service.ready.wait(5))
        service.stop()
        thread.join(5)
        service.close()
        self.assertFalse(thread.is_alive())
        self.assertLess(time.monotonic() - started, 5)

    def test_real_checker_against_fake_server(self):
        with FakeServer() as fake:
            targets = [Target("local", fake.url("/ok"), expect_keyword="hello")]
            service = ProbeService(Config(timeout_seconds=5), targets)
            try:
                results = service.run_round()
            finally:
                service.close()
        self.assertTrue(results[0].up, results[0].error)
        rendered = service.metrics.registry.render()
        self.assertIn('fleetwatch_probe_duration_seconds_count{target="local"} 1', rendered)


if __name__ == "__main__":
    unittest.main()
