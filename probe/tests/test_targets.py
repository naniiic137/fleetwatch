import os
import unittest

from fleetwatch_probe.targets import Target, TargetsError, load_targets, parse_scalar, parse_targets

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


class ParseScalarTest(unittest.TestCase):
    def test_plain_values(self):
        self.assertEqual(parse_scalar("hello world", 1), "hello world")
        self.assertEqual(parse_scalar("200", 1), 200)
        self.assertEqual(parse_scalar("true", 1), True)
        self.assertIsNone(parse_scalar("~", 1))
        self.assertIsNone(parse_scalar("# only a comment", 1))

    def test_plain_value_with_comment(self):
        self.assertEqual(parse_scalar("https://a.example  # main site", 1), "https://a.example")

    def test_url_with_hash_fragment_is_kept(self):
        self.assertEqual(parse_scalar("https://a.example/#top", 1), "https://a.example/#top")

    def test_quoted_values(self):
        self.assertEqual(parse_scalar('"a \\"b\\" \\u00e9"', 1), 'a "b" é')
        self.assertEqual(parse_scalar("'it''s'", 1), "it's")
        self.assertEqual(parse_scalar('"200"', 1), "200")
        self.assertEqual(parse_scalar('"x" # note', 1), "x")

    def test_bad_quotes(self):
        with self.assertRaises(TargetsError):
            parse_scalar('"open', 3)
        with self.assertRaises(TargetsError):
            parse_scalar("'open", 3)
        with self.assertRaises(TargetsError):
            parse_scalar('"a" trailing', 3)

    def test_flow_syntax_rejected(self):
        with self.assertRaises(TargetsError):
            parse_scalar("{a: 1}", 1)


class ParseTargetsTest(unittest.TestCase):
    def test_hand_written_style(self):
        text = """
# comment
targets:
  - name: one
    url: https://one.example
    expect_keyword: "Hello"
  - name: two   # trailing comment
    url: http://two.example:8080/health?full=1
    expect_status: 204
"""
        self.assertEqual(
            parse_targets(text),
            [
                Target("one", "https://one.example", 200, "Hello"),
                Target("two", "http://two.example:8080/health?full=1", 204, None),
            ],
        )

    def test_helm_to_yaml_style(self):
        # helm's toYaml puts list items at the parent's indentation and sorts keys.
        text = "targets:\n- expect_status: 200\n  name: one\n  url: https://one.example\n"
        self.assertEqual(parse_targets(text), [Target("one", "https://one.example", 200, None)])

    def test_repo_targets_file_is_valid(self):
        targets = load_targets(os.path.join(REPO_ROOT, "targets.yaml"))
        self.assertGreaterEqual(len(targets), 1)
        for target in targets:
            self.assertTrue(target.url.startswith("https://"), target.url)

    def test_errors(self):
        cases = {
            "missing key": "foo: 1\n",
            "no targets key": "# nothing\n",
            "empty list": "targets: []\n",
            "item outside": "- name: a\n",
            "missing url": "targets:\n  - name: a\n",
            "bad url": "targets:\n  - name: a\n    url: ftp://a.example\n",
            "bad name": "targets:\n  - name: 'has space'\n    url: https://a.example\n",
            "dup name": (
                "targets:\n  - name: a\n    url: https://a.example\n"
                "  - name: a\n    url: https://b.example\n"
            ),
            "dup key": "targets:\n  - name: a\n    name: b\n",
            "unknown key": "targets:\n  - name: a\n    url: https://a.example\n    foo: 1\n",
            "bad status": (
                "targets:\n  - name: a\n    url: https://a.example\n    expect_status: 42\n"
            ),
            "tab indent": "targets:\n\t- name: a\n",
            "inline value": "targets: nope\n",
        }
        for label, text in cases.items():
            with self.subTest(label), self.assertRaises(TargetsError):
                parse_targets(text)


if __name__ == "__main__":
    unittest.main()
