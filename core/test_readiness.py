from django.test import Client, SimpleTestCase, override_settings


@override_settings(IS_PUBLISHED=True, SECURE_SSL_REDIRECT=True,
                   SECURE_HSTS_SECONDS=3600, X_FRAME_OPTIONS="DENY",
                   ALLOWED_HOSTS=["published.example.invalid", "localhost", "127.0.0.1", "[::1]"])
class ReadinessTests(SimpleTestCase):
    # SimpleTestCase prohibits database access, including session/demo creation.
    def test_direct_loopback_probe(self):
        for host, peer in [("127.0.0.1:80", "127.0.0.1"), ("localhost", "127.0.0.1"),
                           ("[::1]:80", "::1")]:
            for method in ("get", "head"):
                response = getattr(self.client, method)("/", HTTP_HOST=host, REMOTE_ADDR=peer)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response["Cache-Control"], "no-store")
                self.assertFalse(response.cookies)
                self.assertNotIn("Location", response)
        self.assertEqual(self.client.get("/", HTTP_HOST="127.0.0.1:1104",
                                         REMOTE_ADDR="127.0.0.1",
                                         HTTP_X_FORWARDED_FOR="127.0.0.1").status_code, 200)

    def test_probe_exception_is_narrow(self):
        cases = [
            ("/", {"REMOTE_ADDR": "203.0.113.1"}),
            ("/", {"HTTP_HOST": "published.example.invalid"}),
            ("/?demo=1", {}),
            ("/request-demo/", {}),
            ("/", {"HTTP_X_FORWARDED_FOR": "203.0.113.1"}),
            ("/", {"HTTP_X_FORWARDED_FOR": "127.0.0.1", "REMOTE_ADDR": "203.0.113.1"}),
            ("/", {"HTTP_FORWARDED": "for=127.0.0.1"}),
            ("/", {"HTTP_X_FORWARDED_PROTO": "http"}),
        ]
        for path, changes in cases:
            with self.subTest(path=path, changes=changes):
                headers = {"HTTP_HOST": "127.0.0.1", "REMOTE_ADDR": "127.0.0.1"}
                headers.update(changes)
                self.assertEqual(self.client.get(path, **headers).status_code, 301)
        self.assertEqual(self.client.post("/", HTTP_HOST="127.0.0.1").status_code, 301)

    def test_host_validation_precedes_redirect_and_probe(self):
        for scheme in ("http", "https"):
            self.assertEqual(self.client.get("/", HTTP_HOST="attacker.invalid",
                                             HTTP_X_FORWARDED_PROTO=scheme).status_code, 400)

    def test_public_https_and_csrf(self):
        headers = {"HTTP_HOST": "published.example.invalid", "HTTP_X_FORWARDED_PROTO": "https"}
        response = self.client.get("/request-demo/", **headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Strict-Transport-Security"], "max-age=3600")
        self.assertEqual(response["X-Frame-Options"], "DENY")
        self.assertTrue(response.cookies["csrftoken"]["secure"])
        self.assertEqual(Client(enforce_csrf_checks=True).post("/request-demo/", {}, **headers).status_code, 403)