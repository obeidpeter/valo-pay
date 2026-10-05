import os
from unittest import mock
from django.test import SimpleTestCase, override_settings


class DesignReviewSurfaceTests(SimpleTestCase):
    def test_renders_in_development(self):
        with mock.patch.dict(os.environ, {"REPLIT_DEPLOYMENT": ""}):
            r = self.client.get("/__design/")
            self.assertEqual(r.status_code, 200)
            self.assertContains(r, "Development-only")
            for f in ("dense", "empty", "long", "large"):
                t = self.client.get(f"/__design/today/?fixture={f}")
                self.assertEqual(t.status_code, 200)
                self.assertContains(t, "Synthetic")

    def test_signin_action_keeps_query_without_skip_link_fragment(self):
        r = self.client.get("/access/login/?next=/today/")
        self.assertContains(r, 'action="/access/login/?next=/today/"')

    def test_internal_reports_and_source_are_not_application_routes(self):
        for path in (
            "/docs/BROCHURE_DESIGN_GUIDE.md",
            "/evidence/brochure-complete/manifest-after.json",
            "/tests/test_visual_capture.py",
            "/attached_assets/New_Valo_Pay_Brochure_1791072074679.pdf",
        ):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)

    def test_fails_closed_when_deployed(self):
        with mock.patch.dict(os.environ, {"REPLIT_DEPLOYMENT": "1"}):
            self.assertEqual(self.client.get("/__design/").status_code, 404)
            self.assertEqual(self.client.get("/__design/today/?fixture=dense").status_code, 404)

    @override_settings(IS_PUBLISHED=True)
    def test_fails_closed_when_published_setting(self):
        self.assertEqual(self.client.get("/__design/").status_code, 404)

    def test_exact_large_amount_and_unknown_fixture(self):
        r = self.client.get("/__design/today/?fixture=large")
        self.assertContains(r, "₦1,234,567,890,123.45")
        self.assertEqual(self.client.get("/__design/today/?fixture=bogus").status_code, 404)

    def test_today_nav_exactly_six_items_settings_in_account_menu(self):
        r = self.client.get("/__design/today/?fixture=dense").content.decode()
        nav = r.split('aria-label="Main"')[1].split("</nav>")[0]
        self.assertEqual(nav.count("<li>"), 6)
        for label in ("Dashboard", "Customers", "Collections", "Pay-by-bank", "Reviews", "Reports"):
            self.assertIn(label, nav)
        self.assertNotIn("Settings", nav)
