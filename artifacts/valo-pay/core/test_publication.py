from io import StringIO
from unittest.mock import patch
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.core.management import call_command, CommandError
from django.middleware.csrf import _get_new_csrf_string
from django.test import Client, SimpleTestCase, TestCase, override_settings
from valo.hosts import trusted_hosts


class HostConfigurationTests(SimpleTestCase):
    def test_exact_domains_and_no_wildcards(self):
        hosts = trusted_hosts({"REPLIT_DEV_DOMAIN": "preview.example.invalid",
                               "REPLIT_DOMAINS": "published.example.invalid,second.example.invalid"})
        self.assertIn("published.example.invalid", hosts)
        self.assertNotIn("*", hosts)
        for value in ("*", ".example.invalid", "https://example.invalid", "example.invalid:443", "example.invalid/path"):
            with self.subTest(value=value), self.assertRaises(ImproperlyConfigured):
                trusted_hosts({"VALO_ALLOWED_HOSTS": value})
        with self.assertRaises(ImproperlyConfigured):
            trusted_hosts({"REPLIT_DEPLOYMENT": "1"})
        with self.assertRaises(ImproperlyConfigured):
            trusted_hosts({"REPLIT_DEPLOYMENT": "1", "REPLIT_DEV_DOMAIN": "preview.example.invalid"})

    def test_published_settings_and_deploy_checks(self):
        import os
        import subprocess
        from pathlib import Path
        result = subprocess.run(
            ["python", "-c",
             "import django; django.setup(); from django.conf import settings as s; "
             "assert not s.DEBUG and s.SECURE_SSL_REDIRECT and s.SECURE_HSTS_SECONDS == 3600; "
             "assert s.X_FRAME_OPTIONS == 'DENY' and s.SESSION_COOKIE_SECURE and s.CSRF_COOKIE_SECURE; "
             "assert not s.CSRF_TRUSTED_ORIGINS; "
             "from django.core.checks import run_checks; "
             "issues=run_checks(include_deployment_checks=True); "
             "assert {i.id for i in issues} <= {'security.W005','security.W021'}, [i.id for i in issues]"],
            cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, "DJANGO_SETTINGS_MODULE": "valo.settings", "REPLIT_DEPLOYMENT": "1",
                 "REPLIT_DOMAINS": "published.example.invalid"},
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    @override_settings(DEBUG=False, ALLOWED_HOSTS=["published.example.invalid"])
    def test_host_rejected_before_safe_or_static_responses(self):
        client = Client()
        for path in ("/", "/static/valo.css", "/docs/", "/.git/config"):
            self.assertEqual(client.get(path, HTTP_HOST="attacker.invalid").status_code, 400)

    @override_settings(DEBUG=False)
    def test_configuration_gate_rejects_test_flags_and_insecure_cookies(self):
        for option in ({"ACCESS_TEST_DELIVERY": True}, {"SYNTHETIC_LEAD_TEST": True},
                       {"SESSION_COOKIE_SECURE": False}, {"CSRF_COOKIE_SECURE": False},
                       {"ALLOWED_HOSTS": ["*"]}, {"CSRF_TRUSTED_ORIGINS": ["https://elsewhere.invalid"]}):
            with self.subTest(option=option), override_settings(**option), self.assertRaises(CommandError):
                call_command("publication_check", stdout=StringIO())


@override_settings(DEBUG=False, ALLOWED_HOSTS=["published.example.invalid"])
class PublicationRequestTests(TestCase):
    def test_proxy_same_origin_csrf_and_disabled_leads(self):
        client = Client(enforce_csrf_checks=True)
        token = _get_new_csrf_string()
        client.cookies[settings.CSRF_COOKIE_NAME] = token
        data = {"csrfmiddlewaretoken": token}
        headers = {"HTTP_HOST": "published.example.invalid", "HTTP_X_FORWARDED_PROTO": "https"}
        response = client.post("/request-demo/", data, HTTP_ORIGIN="https://published.example.invalid", **headers)
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Public collection is disabled")
        self.assertEqual(client.post("/request-demo/", data, HTTP_ORIGIN="https://attacker.invalid", **headers).status_code, 403)
        self.assertEqual(client.post("/request-demo/", {}, **headers).status_code, 403)
        from .models import DemoLead
        self.assertEqual(DemoLead.objects.count(), 0)

    def test_private_files_are_not_served(self):
        for path in ("/docs/CALENDAR_INCREMENT_HANDOVER.md", "/evidence/calendar-coverage.json",
                     "/.git/config", "/.env", "/core/test_access.py", "/attached_assets/"):
            self.assertEqual(self.client.get(path, HTTP_HOST="published.example.invalid").status_code, 404)

    def test_schema_check_is_read_only_and_missing_schema_fails(self):
        # Django TestCase owns an outer transaction. Mock the SET only here;
        # production command is additionally exercised outside a test transaction.
        from django.db import connection
        from django.db.backends.utils import CursorWrapper
        original = CursorWrapper.execute
        def execute(cursor, sql, params=None):
            if sql == "SET TRANSACTION READ ONLY":
                return None
            self.assertTrue(sql.lstrip().upper().startswith(("SELECT", "SAVEPOINT", "RELEASE")), sql)
            return original(cursor, sql, params)
        with patch.object(CursorWrapper, "execute", execute):
            call_command("publication_check", database=True, stdout=StringIO())
        with patch.object(connection.introspection, "table_names", return_value=[]):
            with patch.object(CursorWrapper, "execute", execute), self.assertRaises(CommandError):
                call_command("publication_check", database=True, stdout=StringIO())