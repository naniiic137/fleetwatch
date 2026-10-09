import io
import json
import logging
import unittest

from fleetwatch_probe.config import Config, ConfigError
from fleetwatch_probe.logjson import JsonFormatter


class ConfigTest(unittest.TestCase):
    def test_defaults(self):
        config = Config.from_env({})
        self.assertEqual(config, Config())
        self.assertEqual(config.port, 8080)
        self.assertEqual(config.interval_seconds, 30.0)

    def test_overrides(self):
        config = Config.from_env(
            {
                "FW_TARGETS_FILE": "/etc/fw/targets.yaml",
                "FW_PORT": "9000",
                "FW_INTERVAL_SECONDS": "15",
                "FW_TIMEOUT_SECONDS": "2.5",
                "FW_CONCURRENCY": "4",
                "FW_LOG_LEVEL": "debug",
                "FW_LISTEN_HOST": "127.0.0.1",
            }
        )
        self.assertEqual(config.targets_file, "/etc/fw/targets.yaml")
        self.assertEqual(config.port, 9000)
        self.assertEqual(config.interval_seconds, 15.0)
        self.assertEqual(config.timeout_seconds, 2.5)
        self.assertEqual(config.concurrency, 4)
        self.assertEqual(config.log_level, "DEBUG")
        self.assertEqual(config.listen_host, "127.0.0.1")

    def test_blank_values_use_defaults(self):
        self.assertEqual(Config.from_env({"FW_PORT": " "}).port, 8080)

    def test_invalid_values(self):
        for env in (
            {"FW_PORT": "http"},
            {"FW_PORT": "70000"},
            {"FW_INTERVAL_SECONDS": "0.5"},
            {"FW_INTERVAL_SECONDS": "nan"},
            {"FW_TIMEOUT_SECONDS": "inf"},
            {"FW_CONCURRENCY": "0"},
            {"FW_LOG_LEVEL": "LOUD"},
        ):
            with self.subTest(env=env), self.assertRaises(ConfigError):
                Config.from_env(env)


class JsonLoggingTest(unittest.TestCase):
    def test_log_line_is_json_with_extra_fields(self):
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(JsonFormatter())
        logger = logging.getLogger("fleetwatch.test")
        logger.addHandler(handler)
        logger.propagate = False
        try:
            logger.warning("check failed", extra={"target": "a", "latency_ms": 12.5})
        finally:
            logger.removeHandler(handler)
        record = json.loads(stream.getvalue())
        self.assertEqual(record["level"], "warning")
        self.assertEqual(record["msg"], "check failed")
        self.assertEqual(record["target"], "a")
        self.assertEqual(record["latency_ms"], 12.5)
        self.assertRegex(record["ts"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")


if __name__ == "__main__":
    unittest.main()
