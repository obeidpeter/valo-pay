"""Local production-start smoke; uses the existing development DB read-only.

Run from the app root: python tests/readiness_smoke.py
Never point this script at production or visit a sample-demo route.
"""
import http.client
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time


root = Path(__file__).resolve().parents[1]
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
env = {**os.environ, "PORT": str(port), "REPLIT_DEPLOYMENT": "1",
       "VALO_ALLOWED_HOSTS": "published.example.invalid",
       "PGOPTIONS": "-c default_transaction_read_only=on"}
cases = [
    ("direct loopback", "GET", "/", {}, 200),
    ("router loopback", "GET", "/", {"Host": "127.0.0.1:1104", "X-Forwarded-For": "127.0.0.1"}, 200),
    ("router HEAD", "HEAD", "/", {"Host": "127.0.0.1:1104"}, 200),
    ("public HTTP", "GET", "/", {"Host": "published.example.invalid"}, 301),
    ("proxy HTTPS", "GET", "/request-demo/", {"Host": "published.example.invalid", "X-Forwarded-Proto": "https"}, 200),
    ("forwarded external client", "GET", "/", {"Host": "127.0.0.1:1104", "X-Forwarded-For": "203.0.113.1"}, 301),
    ("wrong internal port", "GET", "/", {"Host": "127.0.0.1:9999"}, 301),
    ("internal non-root", "GET", "/request-demo/", {}, 301),
    ("internal POST", "POST", "/", {}, 301),
    ("unknown host", "GET", "/", {"Host": "attacker.invalid"}, 400),
    ("HTTPS CSRF failure", "POST", "/request-demo/", {"Host": "published.example.invalid", "X-Forwarded-Proto": "https"}, 403),
]
with tempfile.TemporaryFile(mode="w+") as log:
    proc = subprocess.Popen(["sh", str(root / "bin/serve")], cwd="/tmp",
                            env=env, stdout=log, stderr=log, start_new_session=True)
    try:
        for _ in range(100):
            if proc.poll() is not None:
                raise RuntimeError("Production-start process exited early")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=.2):
                    break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError("Production-start timed out")
        results = []
        for name, method, path, headers, expected in cases:
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            connection.request(method, path, headers=headers)
            response = connection.getresponse()
            body = response.read()
            assert response.status == expected, (name, response.status)
            if name == "proxy HTTPS":
                assert response.getheader("Strict-Transport-Security") == "max-age=3600"
                assert response.getheader("X-Frame-Options") == "DENY"
                assert "Secure" in response.getheader("Set-Cookie", "")
            if name in {"direct loopback", "router loopback", "router HEAD"}:
                assert body == (b"" if method == "HEAD" else b"ok\n")
                assert not response.getheader("Set-Cookie")
                assert not response.getheader("Location")
                assert response.getheader("Cache-Control") == "no-store"
            results.append({"check": name, "status": response.status})
            connection.close()
        print(json.dumps({"readOnlyDatabaseSession": True, "checks": results}, indent=2))
    finally:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=15)