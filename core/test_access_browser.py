"""Actual browser journeys on an isolated temporary PostgreSQL test database only."""
import os
import re
import secrets
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from django.contrib.auth import get_user_model
from django.contrib.sessions.models import Session
from django.contrib.sessions.backends.db import SessionStore
from django.core import mail
from django.db import connections
from django.contrib.staticfiles.testing import StaticLiveServerTestCase
from django.test import override_settings, tag
from django_otp.oath import totp
from django_otp.plugins.otp_totp.models import TOTPDevice
from playwright.sync_api import sync_playwright, expect
from .models import Organisation, StaffMembership


@override_settings(ACCESS_TEST_DELIVERY=True,
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
    BREACHED_PASSWORD_SHA1=[], SESSION_COOKIE_SECURE=False, CSRF_COOKIE_SECURE=False,
    PASSWORD_HASHERS=["django.contrib.auth.hashers.Argon2PasswordHasher"],
    CONN_MAX_AGE=0)
class IsolatedBrowserJourney(StaticLiveServerTestCase):
    def db_call(self, fn):
        def call():
            try:
                return fn()
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(call).result()

    @tag("performance")
    def test_invite_enrol_reset_fallback_idle_browser(self):
        password = secrets.token_urlsafe(28)
        org = Organisation.objects.create(name="Synthetic Browser Organisation")
        admin = get_user_model().objects.create_user("browser-admin@example.invalid", email="browser-admin@example.invalid", password=password)
        StaffMembership.objects.create(user=admin, organisation=org, role="Admin")
        admin_device = TOTPDevice.objects.create(user=admin, confirmed=True)
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=shutil.which("chromium"), headless=True, args=["--no-sandbox"])
            print("Isolated auth browser version:", browser.version)
            page = browser.new_page(viewport={"width":360,"height":850})
            def visit(path):
                page.goto(self.live_server_url+path)
            def submit():
                page.locator("[data-access-form] button[type=submit]").click()
            def signin(email, secret):
                visit("/access/login/")
                page.get_by_label("Email", exact=True).fill(email)
                page.get_by_label("Password", exact=True).fill(secret)
                submit()
            signin(admin.username, password)
            page.get_by_label("Code", exact=True).fill(str(totp(admin_device.bin_key)).zfill(6))
            submit()
            page.locator("select[name=organisation]").select_option(index=1)
            submit()
            # This journey is 360px wide. Wait for the redirected staff page's
            # enhanced navigation rather than inspecting during stylesheet load.
            expect(page.locator(".menu-toggle")).to_be_visible()
            expect(page.locator(".menu-toggle")).to_have_js_property("hidden", False)
            page.locator(".menu-toggle").click()
            expect(page.locator(".menu-toggle")).to_have_attribute("aria-expanded", "true")
            page.locator("details.acct > summary").click()
            page.get_by_role("link", name="Account and team access").click()
            page.get_by_role("link", name=re.compile("invit", re.I)).click()
            page.get_by_label("Email", exact=True).fill("browser-new@example.invalid")
            page.get_by_label("Role", exact=True).select_option("Preparer")
            submit()
            expect(page.get_by_role("heading", name="Invitation issued", exact=True)).to_be_visible()
            invite = re.search(r"/access/invitation/[^/]+/", mail.outbox[-1].body).group()
            page.get_by_role("button", name="Sign out", exact=True).click()
            visit(invite)
            page.get_by_label("Password", exact=True).fill(password)
            page.get_by_label("Confirm password", exact=True).fill(password)
            submit()
            expect(page.get_by_label("Setup key (time-based, 6 digits)")).to_be_visible()
            # Never screenshot or print enrollment secrets.
            user = self.db_call(lambda: get_user_model().objects.get(username="browser-new@example.invalid"))
            device = self.db_call(lambda: TOTPDevice.objects.get(user=user))
            page.get_by_label("Code", exact=True).fill(str(totp(device.bin_key)).zfill(6))
            submit()
            page.locator("select[name=organisation]").select_option(index=1)
            submit()
            expect(page.get_by_role("heading", name="Today", exact=True)).to_be_visible()
            visit("/import/")
            page.locator("#csv_data").fill("customer_id,name,email,phone,loan_id,product,amount,due_date\nBROWSER-1,Synthetic Borrower,borrower@example.invalid,,BROWSER-L1,Test,100.00,2027-01-01")
            page.get_by_role("button",name="Validate rows",exact=True).click()
            page.get_by_role("button",name="Import 1 rows",exact=True).click()
            expect(page.get_by_role("link",name="Synthetic Borrower",exact=True)).to_be_visible()
            visit("/payments/new/")
            page.locator("select[name=instalment]").select_option(index=1)
            page.locator("input[name=amount]").fill("100.00")
            page.locator("input[name=confirmed]").check()
            page.locator("button[type=submit]").last.click()
            expect(page.get_by_role("heading",name=re.compile("VP-DEMO-"))).to_be_visible()
            borrower_url=page.get_by_label("Customer payment link").input_value()
            page.goto(borrower_url)
            page.get_by_role("button",name="Check current availability").click()
            expect(page.get_by_text("The latest stored state is shown.",exact=False)).to_be_visible()
            # Measure the real imported large dataset, not only the small seed.
            import json
            bulk="customer_id,name,email,phone,loan_id,product,amount,due_date\n"+"\n".join(
                f"LOAD-{n},Synthetic Load {n},load{n}@example.invalid,,LOAD-L{n},Test,100.00,2027-01-01" for n in range(5000))
            visit("/import/")
            expect(page.get_by_role("heading",name="Import instalments",exact=True)).to_be_visible()
            page.locator("#csv_file").set_input_files({"name":"synthetic-5000.csv","mimeType":"text/csv","buffer":bulk.encode()})
            page.wait_for_function("document.querySelector('#csv_data')?.value.startsWith('customer_id,')")
            start=time.perf_counter()
            page.get_by_role("button",name="Validate rows",exact=True).click()
            expect(page.get_by_role("button",name="Import 5000 rows",exact=True)).to_be_visible()
            preview_seconds=time.perf_counter()-start
            start=time.perf_counter()
            page.get_by_role("button",name="Import 5000 rows",exact=True).click(timeout=120000)
            expect(page.get_by_role("heading",name="Customers",exact=True)).to_be_visible()
            commit_seconds=time.perf_counter()-start
            Path("evidence").mkdir(exist_ok=True)
            Path("evidence/import-5000-browser.json").write_text(json.dumps({
                "imported_rows":5000,"dataset_customers":5001,"dataset_instalments":5001,"preview_rows":50,
                "preview_seconds":preview_seconds,"commit_seconds":commit_seconds,"csv_bytes":len(bulk.encode()),
                "conditions":"Isolated PostgreSQL; real signed-in Chromium; unthrottled local HTTP; commit includes subsequent customer-list navigation"},indent=2))
            from .browser_audit import audit_routes
            from .models import Loan
            def prepare_consent():
                loan=Loan.objects.get(organisation=org,reference="BROWSER-L1")
                from django.utils import timezone
                loan.consent_status="Requested";loan.consent_requested_at=timezone.now();loan.save()
                return self.live_server_url+"/consent/"+loan.consent_token+"/"
            consent_url=self.db_call(prepare_consent)
            audit_routes(page,self.live_server_url,borrower_url,consent_url)
            visit("/today/")
            self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), 360)
            Path("evidence").mkdir(exist_ok=True)
            page.screenshot(path="evidence/auth-isolated-workspace.png", full_page=True)
            # Advance an unattended browser clock; server expiry is tested separately.
            page.clock.install()
            visit("/today/")
            page.clock.fast_forward(1681000)
            expect(page.get_by_role("button", name="Stay signed in", exact=True)).to_be_visible()
            page.get_by_role("button", name="Stay signed in", exact=True).click()
            expect(page.locator("#idle")).to_be_hidden()
            if page.locator(".menu-toggle").is_visible():
                page.locator(".menu-toggle").click()
            page.locator("details.acct > summary").click()
            page.get_by_role("button", name="Sign out", exact=True).click()
            visit("/access/reset/")
            page.get_by_label("Email", exact=True).fill(user.username)
            submit()
            reset = re.search(r"/access/reset/[^/]+/", mail.outbox[-1].body).group()
            visit(reset)
            changed = secrets.token_urlsafe(28)
            page.get_by_label("Password", exact=True).fill(changed)
            page.get_by_label("Confirm password", exact=True).fill(changed)
            submit()
            signin(user.username, changed)
            expect(page.get_by_role("heading", name="Two-step verification", exact=True)).to_be_visible()
            page.get_by_role("button", name="Send a one-time code by email instead").click()
            raw = mail.outbox[-1].body
            page.get_by_label("Code", exact=True).fill(raw)
            self.assertEqual(page.get_by_label("Code", exact=True).input_value(), raw)
            submit()
            expect(page.get_by_role("heading", name="Choose an organisation", exact=True)).to_be_visible()
            browser.close()