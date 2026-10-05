"""Synthetic-only browser regression for the intentional demo journey."""
import re
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from django.db import connections
from django.contrib.auth import get_user_model
from django.contrib.staticfiles.testing import StaticLiveServerTestCase
from django.test import override_settings
from playwright.sync_api import expect, sync_playwright

from .models import Audit, Member, Organisation


@override_settings(SESSION_COOKIE_SECURE=False, CSRF_COOKIE_SECURE=False, CONN_MAX_AGE=0)
class DemoBrowserRegression(StaticLiveServerTestCase):
    """All writes are made by the demo flow inside Django's isolated test database."""

    def db_call(self, fn):
        def call():
            try:
                return fn()
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(call).result()

    def test_complete_synthetic_demo_browser_journey(self):
        self.assertEqual(self.db_call(lambda: Organisation.objects.count()), 0)
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=shutil.which("chromium"),
                                        headless=True, args=["--no-sandbox"])
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            origin = self.live_server_url
            page.goto(origin + "/demo/")
            expect(page.get_by_role("heading", name="Explore Valo Pay with sample data")).to_be_visible()
            self.assertEqual(self.db_call(lambda: Organisation.objects.count()), 0)
            page.keyboard.press("Tab")
            expect(page.get_by_role("link", name="Skip to content")).to_be_focused()
            page.get_by_role("button", name="Start the demo", exact=True).click()
            expect(page).to_have_url(re.compile(r"/demo/guide/$"))
            self.assertEqual(self.db_call(lambda: Organisation.objects.count()), 1)
            expect(page.get_by_role("list", name="Guide steps").get_by_role("listitem")).to_have_count(10)

            # Exercise each server-generated destination and simulated role switch.
            for number in range(1, 11):
                button = page.get_by_role("button", name=re.compile(
                    rf"Open step {number} as (Admin|Preparer|Reviewer)$"))
                button.click()
                expect(page).not_to_have_url(re.compile(r"evil\.invalid"))
                self.assertTrue(page.url.startswith(origin + "/"))
                expect(page.locator("details.acct summary")).to_contain_text(
                    ["Admin", "Preparer", "Reviewer"][number - 1] if number <= 3 else
                    ("Preparer" if number in (4, 5, 7, 8) else "Reviewer" if number == 6 else "Admin"))
                if number == 1:
                    expect(page.get_by_role("heading", name="Dashboard", exact=True)).to_be_visible()
                if number == 5:
                    expect(page.get_by_text(re.compile("provider is not connected", re.I))).to_be_visible()
                page.goto(origin + "/demo/guide/")
            # A real synthetic request makes the copy announcement check mandatory.
            def sample_request():
                from datetime import timedelta
                from django.utils import timezone
                from .models import Instalment, PaymentRequest
                inst=Instalment.objects.filter(loan__on_hold=False).exclude(state="Paid").first()
                return PaymentRequest.objects.create(organisation=inst.organisation,
                    instalment=inst,reference="COPY-BROWSER-SAMPLE",amount=100,
                    expires_at=timezone.now()+timedelta(hours=1)).pk
            request_id=self.db_call(sample_request)
            page.goto(origin+f"/payments/{request_id}/")
            page.get_by_role("button",name="Copy link",exact=True).click()
            expect(page.locator("#live")).to_have_text("Link copied to clipboard")
            page.goto(origin+"/demo/guide/")
            expect(page.get_by_role("list", name="Guide steps").get_by_role("listitem")).to_have_count(10)

            # Six primary navigation entries, keyboard-operable guide controls,
            # and narrow viewport document-width checks.
            expect(page.get_by_role("navigation", name="Main").get_by_role("link")).to_have_count(6)
            page.goto(origin + "/demo/")
            expect(page.get_by_role("link", name="Continue to Dashboard")).to_be_visible()
            page.get_by_role("link", name="Continue to Dashboard").click()
            expect(page.get_by_role("heading", name="Dashboard", exact=True)).to_be_visible()
            for width in (320, 390):
                page.set_viewport_size({"width": width, "height": 850})
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), width,
                                     f"document overflows at {width}px on Today")
                page.goto(origin + "/demo/guide/")
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), width,
                                     f"document overflows at {width}px on guide")
                expect(page.get_by_role("button", name="Open step 1 as Admin")).to_be_visible()

            # Restart cancel is non-destructive; confirmation is required before
            # the browser is detached and a new organization is created.
            page.set_viewport_size({"width": 1440, "height": 1000})
            page.goto(origin + "/today/")
            old_id = page.locator(".org").inner_text()
            old_org_ids = self.db_call(lambda: list(
                Organisation.objects.order_by("pk").values_list("pk", flat=True)))
            old_rows = self.db_call(lambda: (Organisation.objects.count(), Member.objects.count(),
                                               Audit.objects.count()))
            page.goto(origin + "/demo/restart/")
            expect(page.get_by_role("heading", name="Start again with fresh sample data?")).to_be_visible()
            page.get_by_role("link", name="Cancel").click()
            expect(page.get_by_role("link", name="Continue to Dashboard")).to_be_visible()
            page.goto(origin + "/demo/restart/")
            page.get_by_role("button", name="Restart the demo", exact=True).click()
            expect(page.get_by_role("checkbox", name=re.compile("current sample workspace will be detached"))).to_be_visible()
            page.get_by_role("checkbox", name=re.compile("current sample workspace will be detached")).check()
            page.get_by_role("button", name="Restart the demo", exact=True).click()
            expect(page.get_by_role("heading", name="Demo guide")).to_be_visible()
            new_org_ids = self.db_call(lambda: list(
                Organisation.objects.order_by("pk").values_list("pk", flat=True)))
            self.assertTrue(set(old_org_ids).issubset(set(new_org_ids)))
            self.assertEqual(len(new_org_ids), len(old_org_ids) + 1)
            self.assertEqual(self.db_call(lambda: (Organisation.objects.count(), Member.objects.count(),
                                                    Audit.objects.count())), (old_rows[0] + 1,
                                                                            old_rows[1] + 4,
                                                                            old_rows[2] + 1))

            # A link-copy control, if seeded/available, must announce success.
            page.goto(origin + "/payments/")
            copy = page.get_by_role("button", name="Copy link")
            if copy.count():
                copy.first.click()
                expect(page.locator("#live")).not_to_be_empty()

            # Landing and sign-in remain public and distinct; provider claims stay
            # explicitly unavailable throughout the demo pages.
            page.goto(origin + "/")
            expect(page.get_by_role("link", name=re.compile("sign in", re.I)).first).to_be_visible()
            page.goto(origin + "/access/login/")
            expect(page.get_by_role("heading", name=re.compile("sign in", re.I)).first).to_be_visible()
            page.goto(origin + "/demo/")
            expect(page.get_by_text(re.compile("No real payments or messages"))).to_be_visible()
            Path("evidence/pr-integration").mkdir(parents=True, exist_ok=True)
            page.screenshot(path="evidence/pr-integration/demo-start-final.png", full_page=True)
            browser.close()