import re
import unittest

from fleetwatch_probe.metrics import (
    Counter,
    Registry,
    escape_label_value,
    format_value,
)

# One sample line of the text format: name, optional {labels}, value.
SAMPLE_RE = re.compile(
    r'^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\[\\"n])*"'
    r'(,[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\[\\"n])*")*\})? '
    r"(NaN|[+-]Inf|[-+]?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?)$"
)


def assert_valid_exposition(test: unittest.TestCase, text: str) -> None:
    test.assertTrue(text.endswith("\n"))
    typed = set()
    for line in text.rstrip("\n").split("\n"):
        if line.startswith("# HELP "):
            continue
        if line.startswith("# TYPE "):
            _, _, name, kind = line.split(" ")
            test.assertIn(kind, {"counter", "gauge", "histogram", "summary", "untyped"})
            typed.add(name)
            continue
        test.assertRegex(line, SAMPLE_RE)
        base = re.sub(r"(_bucket|_sum|_count)$", "", line.split("{")[0].split(" ")[0])
        test.assertTrue(line.split("{")[0].split(" ")[0] in typed or base in typed, line)


class FormatTest(unittest.TestCase):
    def test_format_value(self):
        self.assertEqual(format_value(1.0), "1")
        self.assertEqual(format_value(0.25), "0.25")
        self.assertEqual(format_value(float("inf")), "+Inf")
        self.assertEqual(format_value(float("-inf")), "-Inf")
        self.assertEqual(format_value(float("nan")), "NaN")

    def test_escape_label_value(self):
        self.assertEqual(escape_label_value('a\\b"c\nd'), 'a\\\\b\\"c\\nd')


class RegistryTest(unittest.TestCase):
    def test_counter_and_gauge_render_exactly(self):
        registry = Registry()
        counter = registry.counter("demo_requests_total", "Requests.\nSecond line", ("path",))
        gauge = registry.gauge("demo_up", "Up or not.")
        counter.inc({"path": "/a"})
        counter.inc({"path": "/a"}, 2)
        counter.inc({"path": 'q"uote'})
        gauge.set(1)
        self.assertEqual(
            registry.render(),
            "# HELP demo_requests_total Requests.\\nSecond line\n"
            "# TYPE demo_requests_total counter\n"
            'demo_requests_total{path="/a"} 3\n'
            'demo_requests_total{path="q\\"uote"} 1\n'
            "# HELP demo_up Up or not.\n"
            "# TYPE demo_up gauge\n"
            "demo_up 1\n",
        )

    def test_histogram_buckets_are_cumulative(self):
        registry = Registry()
        hist = registry.histogram("demo_seconds", "Latency.", ("target",), buckets=(0.1, 1.0))
        for value in (0.05, 0.5, 0.7, 3.0):
            hist.observe(value, {"target": "x"})
        self.assertEqual(
            registry.render(),
            "# HELP demo_seconds Latency.\n"
            "# TYPE demo_seconds histogram\n"
            'demo_seconds_bucket{target="x",le="0.1"} 1\n'
            'demo_seconds_bucket{target="x",le="1"} 3\n'
            'demo_seconds_bucket{target="x",le="+Inf"} 4\n'
            'demo_seconds_sum{target="x"} 4.25\n'
            'demo_seconds_count{target="x"} 4\n',
        )
        assert_valid_exposition(self, registry.render())

    def test_observation_on_bucket_boundary_counts_as_le(self):
        registry = Registry()
        hist = registry.histogram("b_seconds", "x", buckets=(1.0,))
        hist.observe(1.0)
        cumulative, total, count = hist.snapshot()
        self.assertEqual(cumulative, [1, 1])
        self.assertEqual((total, count), (1.0, 1))

    def test_validation(self):
        with self.assertRaises(ValueError):
            Counter("no_suffix", "x")
        registry = Registry()
        registry.gauge("dup", "x")
        with self.assertRaises(ValueError):
            registry.gauge("dup", "x")
        with self.assertRaises(ValueError):
            registry.gauge("bad-name", "x")
        with self.assertRaises(ValueError):
            registry.histogram("h", "x", ("le",))
        counter = registry.counter("c_total", "x", ("a",))
        with self.assertRaises(ValueError):
            counter.inc({"b": "1"})
        with self.assertRaises(ValueError):
            counter.inc({"a": "1"}, -1)

    def test_empty_family_still_has_help_and_type(self):
        registry = Registry()
        registry.counter("nothing_yet_total", "Nothing yet.", ("x",))
        self.assertEqual(
            registry.render(),
            "# HELP nothing_yet_total Nothing yet.\n# TYPE nothing_yet_total counter\n",
        )


if __name__ == "__main__":
    unittest.main()
