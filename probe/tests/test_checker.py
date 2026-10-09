import socket
import ssl
import time
import unittest
from unittest import mock

from fleetwatch_probe.checker import cert_days_left, check_target
from fleetwatch_probe.targets import Target

from .fakes import FakeServer, free_port, make_self_signed_cert, temp_dir


class CheckerHTTPTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = FakeServer().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.server.__exit__(None, None, None)

    def check(self, path, **target_kwargs):
        target = Target(name="t", url=self.server.url(path), **target_kwargs)
        return check_target(target, timeout=5)

    def test_ok_with_keyword(self):
        result = self.check("/ok", expect_keyword="hello fleetwatch")
        self.assertTrue(result.up)
        self.assertEqual(result.status_code, 200)
        self.assertTrue(result.keyword_found)
        self.assertIsNone(result.reason)
        self.assertIsNone(result.cert_days_left)  # plain http
        self.assertGreaterEqual(result.latency_seconds, 0)
        self.assertLess(result.latency_seconds, 5)

    def test_missing_keyword(self):
        result = self.check("/ok", expect_keyword="not on the page")
        self.assertFalse(result.up)
        self.assertEqual(result.reason, "keyword")
        self.assertFalse(result.keyword_found)

    def test_unexpected_status(self):
        result = self.check("/error")
        self.assertFalse(result.up)
        self.assertEqual(result.status_code, 500)
        self.assertEqual(result.reason, "status")

    def test_expected_non_200_status(self):
        result = self.check("/error", expect_status=500)
        self.assertTrue(result.up)

    def test_redirects_are_not_followed(self):
        result = self.check("/redirect")
        self.assertEqual(result.status_code, 301)
        self.assertEqual(result.reason, "status")
        self.assertTrue(self.check("/redirect", expect_status=301).up)

    def test_timeout(self):
        target = Target(name="slow", url=self.server.url("/slow"))
        started = time.monotonic()
        result = check_target(target, timeout=0.3)
        self.assertLess(time.monotonic() - started, 1.4)
        self.assertFalse(result.up)
        self.assertEqual(result.reason, "timeout")

    def test_protocol_error(self):
        result = self.check("/garbage")
        self.assertFalse(result.up)
        self.assertIn(result.reason, ("protocol", "connection"))

    def test_body_read_is_capped(self):
        target = Target(name="t", url=self.server.url("/ok"), expect_keyword="fleetwatch")
        result = check_target(target, timeout=5, max_body_bytes=10)
        self.assertEqual(result.reason, "keyword")

    def test_to_dict_rounds_numbers(self):
        data = self.check("/ok").to_dict()
        self.assertEqual(data["target"], "t")
        self.assertIsInstance(data["latency_seconds"], float)


class CheckerNetworkErrorTest(unittest.TestCase):
    def test_connection_refused(self):
        target = Target(name="closed", url=f"http://127.0.0.1:{free_port()}/")
        result = check_target(target, timeout=5)
        self.assertFalse(result.up)
        self.assertIn(result.reason, ("connection", "timeout"))
        self.assertIsNone(result.status_code)
        self.assertIsNone(result.latency_seconds)

    def test_dns_failure(self):
        # No real DNS query: getaddrinfo is replaced by one that always fails.
        error = socket.gaierror(socket.EAI_NONAME, "Name or service not known")
        with mock.patch("socket.getaddrinfo", side_effect=error):
            result = check_target(Target(name="dns", url="http://fleetwatch.invalid/"), timeout=5)
        self.assertFalse(result.up)
        self.assertEqual(result.reason, "dns")


class CertDaysTest(unittest.TestCase):
    def test_cert_days_left(self):
        not_after = "Jan 31 00:00:00 2030 GMT"
        expiry = ssl.cert_time_to_seconds(not_after)
        self.assertAlmostEqual(cert_days_left(not_after, expiry - 14 * 86400), 14.0)
        self.assertAlmostEqual(cert_days_left(not_after, expiry + 86400), -1.0)


class CheckerTLSTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = temp_dir()
        pair = make_self_signed_cert(cls.tmp.name, days=30)
        if pair is None:
            cls.tmp.cleanup()
            raise unittest.SkipTest("openssl CLI not available to create a test certificate")
        cls.cert, key = pair
        server_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_ctx.load_cert_chain(cls.cert, key)
        cls.server = FakeServer(ssl_context=server_ctx).__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.server.__exit__(None, None, None)
        cls.tmp.cleanup()

    def client_context(self):
        ctx = ssl.create_default_context(cafile=self.cert)
        ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
        return ctx

    def test_https_reports_cert_expiry(self):
        target = Target(name="tls", url=self.server.url("/ok"), expect_keyword="hello")
        result = check_target(target, timeout=5, ssl_context=self.client_context())
        self.assertTrue(result.up, result.error)
        self.assertIsNotNone(result.cert_days_left)
        self.assertGreater(result.cert_days_left, 29)
        self.assertLessEqual(result.cert_days_left, 30.01)

    def test_untrusted_cert_is_a_tls_failure(self):
        target = Target(name="tls", url=self.server.url("/ok"))
        result = check_target(target, timeout=5, ssl_context=ssl.create_default_context())
        self.assertFalse(result.up)
        self.assertEqual(result.reason, "tls")


if __name__ == "__main__":
    unittest.main()
