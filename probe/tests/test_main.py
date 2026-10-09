"""End-to-end: run ``python -m fleetwatch_probe`` and stop it with SIGTERM."""

import json
import os
import signal
import subprocess
import sys
import time
import unittest
import urllib.request

from .fakes import FakeServer, free_port, temp_dir

PROBE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


class MainTest(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "SIGTERM cannot be delivered gracefully on Windows")
    def test_sigterm_exits_cleanly(self):
        with FakeServer() as fake, temp_dir() as tmp:
            targets_file = os.path.join(tmp, "targets.yaml")
            with open(targets_file, "w", encoding="utf-8") as handle:
                handle.write(f"targets:\n  - name: local\n    url: {fake.url('/ok')}\n")
            port = free_port()
            env = dict(
                os.environ,
                FW_TARGETS_FILE=targets_file,
                FW_PORT=str(port),
                FW_LISTEN_HOST="127.0.0.1",
                FW_INTERVAL_SECONDS="60",
                PYTHONPATH=PROBE_DIR,
            )
            proc = subprocess.Popen(
                [sys.executable, "-m", "fleetwatch_probe"],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            try:
                deadline = time.monotonic() + 15
                ready = False
                while time.monotonic() < deadline and not ready:
                    try:
                        url = f"http://127.0.0.1:{port}/readyz"
                        with urllib.request.urlopen(url, timeout=1) as response:
                            ready = response.status == 200
                    except OSError:
                        time.sleep(0.2)
                self.assertTrue(ready, "probe never became ready")
                proc.send_signal(signal.SIGTERM)
                output, _ = proc.communicate(timeout=15)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.communicate()
        self.assertEqual(proc.returncode, 0, output)
        messages = [json.loads(line)["msg"] for line in output.splitlines() if line.strip()]
        self.assertIn("ready", messages)
        self.assertIn("shutdown requested", messages)
        self.assertEqual(messages[-1], "fleetwatch probe stopped")

    def test_bad_targets_file_exits_with_code_2(self):
        env = dict(os.environ, FW_TARGETS_FILE="/nonexistent/targets.yaml", PYTHONPATH=PROBE_DIR)
        proc = subprocess.run(
            [sys.executable, "-m", "fleetwatch_probe"],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stdout.splitlines()[0])["msg"], "cannot load targets")


if __name__ == "__main__":
    unittest.main()
