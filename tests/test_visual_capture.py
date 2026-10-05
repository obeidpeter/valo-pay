"""Development-only visual capture on an isolated, disposable Django test database.

Skipped unless VISUAL_CAPTURE=before|after. Never touches the preview database or
existing sessions: StaticLiveServerTestCase creates and destroys its own test DB.
Never screenshots credentials, OTP values, enrolment secrets or bearer tokens:
borrower token URLs are recorded only as a route label, not as a full URL.

  VISUAL_CAPTURE=after python manage.py test tests.test_visual_capture
"""
import json
import os
import shutil
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from unittest import skipUnless

from django.contrib.staticfiles.testing import StaticLiveServerTestCase
from django.db import connections
from django.test import override_settings
from django.utils import timezone

import secrets
STAFF_PW = secrets.token_urlsafe(24)
DENSE_ROWS = int(os.environ.get("DENSE_ROWS", "600"))
PHASE = os.environ.get("VISUAL_CAPTURE", "")
OUT = Path(__file__).resolve().parent.parent / "evidence" / "brochure-complete"
SHOT_WIDTHS = [390, 1440]
ONLY = os.environ.get("CAPTURE_ONLY", "")
REFLOW_WIDTHS = [320, 360, 390, 600, 768, 1024, 1440, 1920]


@skipUnless(PHASE in ("before", "after"), "visual capture only on request")
@override_settings(SESSION_COOKIE_SECURE=False, CSRF_COOKIE_SECURE=False, CONN_MAX_AGE=0, ACCESS_TEST_DELIVERY=True,
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend", BREACHED_PASSWORD_SHA1=[])
class VisualCapture(StaticLiveServerTestCase):
    def db(self, fn):
        def call():
            try:
                return fn()
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(call).result()

    def test_capture(self):
        from playwright.sync_api import sync_playwright
        from core.models import Customer, PaymentRequest, Review, Payment, Loan, Organisation

        (OUT / PHASE).mkdir(parents=True, exist_ok=True)
        manifest, reflow, weights = [], [], []
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=shutil.which("chromium"), headless=True, args=["--no-sandbox"])
            ctx = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce")
            page = ctx.new_page()
            base = self.live_server_url
            page.goto(base + "/demo/")  # seeds synthetic org inside the disposable test DB only

            def ids():
                org = Customer.objects.order_by("-id").first().organisation
                c = Customer.objects.filter(organisation=org)
                many = max(c, key=lambda x: x.loans.count())
                loanless = Customer.objects.create(organisation=org, name="Ngozi Eze-Adeyemi (Synthetic, no loans)",
                    external_id="SYN-CUS-9001", email="ngozi@example.invalid", phone="")
                from core.models import Instalment
                free = list(Instalment.objects.filter(organisation=org, paid=0).order_by("id"))
                states = {}
                for n, status in enumerate(("Awaiting approval", "Awaiting confirmation", "Unknown", "Confirmed", "Expired")):
                    inst = free[n]
                    PaymentRequest.objects.filter(instalment=inst).delete()
                    r = PaymentRequest.objects.create(organisation=org, instalment=inst, reference=f"SYN-VC-{n}",
                        amount=inst.amount, status=status, expires_at=timezone.now() + (timedelta(days=-1) if status == "Expired" else timedelta(days=3)))
                    states[status] = r.token
                reqs = [PaymentRequest.objects.get(token=states["Awaiting approval"])]
                loans = list(Loan.objects.filter(organisation=org).order_by("id"))
                valid_loan = next((l for l in loans if l.consent_status == "Requested"), None)
                if valid_loan is None and loans:
                    valid_loan = loans[0]; valid_loan.consent_status = "Requested"
                    valid_loan.consent_requested_at = timezone.now(); valid_loan.consent_expiry = timezone.localdate() + timedelta(days=200)
                    valid_loan.save()
                withdrawn = next((l for l in loans if l != valid_loan), loans[0])
                withdrawn.consent_status = "Withdrawn"; withdrawn.save()
                from core.models import Payment as P
                dense = Customer.objects.create(organisation=org, name="Oluwaseun Adébáyọ̀-Okonkwo Ìbídùnní (Synthetic dense)", external_id="SYN-CUS-DENSE", email="dense@example.invalid", phone="")
                dl = Loan.objects.get(pk=loans[0].pk); dl.pk = None; dl.customer = dense; dl.reference = "SYN-LN-DENSE"
                from core.models import token as tk2
                dl.consent_token = tk2(); dl.save()
                today = timezone.localdate()
                Instalment.objects.bulk_create([Instalment(organisation=org, loan=dl, sequence=n + 1, due_date=today + timedelta(days=n), amount=123456789012 + n,
                    paid=(123456789012 + n) if n < 150 else 0) for n in range(DENSE_ROWS)])
                firsts = list(Instalment.objects.filter(loan=dl).order_by("sequence")[:150])
                P.objects.bulk_create([P(organisation=org, instalment=i, reference=f"SYN-DP-{i.sequence}", amount=i.amount, paid_at=timezone.now()) for i in firsts])
                from django.contrib.auth import get_user_model
                from django_otp.plugins.otp_totp.models import TOTPDevice
                from core.models import StaffMembership
                u = get_user_model().objects.create_user("capture-admin@example.invalid", email="capture-admin@example.invalid", password=STAFF_PW)
                StaffMembership.objects.create(user=u, organisation=org, role="Admin")
                org2 = Organisation.objects.create(name="Second Synthetic Cooperative")
                StaffMembership.objects.create(user=u, organisation=org2, role="Viewer")
                dev = TOTPDevice.objects.create(user=u, confirmed=True)
                nomem = get_user_model().objects.create_user("capture-nomember@example.invalid", email="capture-nomember@example.invalid", password=STAFF_PW)
                nk = TOTPDevice.objects.create(user=nomem, confirmed=True).bin_key
                return dict(nomem_key=nk, dense=dense.pk, totp_key=dev.bin_key, customer=many.pk, loanless=loanless.pk,
                    req=reqs[0].pk if reqs else None, review=Review.objects.filter(organisation=org).first().pk,
                    payment=Payment.objects.filter(organisation=org).first().pk,
                    consent_valid=valid_loan.consent_token, consent_withdrawn=withdrawn.consent_token,
                    **{"pay_" + k: v for k, v in states.items()})
            I = self.db(ids)

            staff = [
                ("today", "/today/"), ("customers", "/customers/"), ("customers-search-none", "/customers/?q=zzzz-no-match"),
                ("customers-filter-hold", "/customers/?filter=hold"), ("customers-page2", "/customers/?page=2"),
                ("customer-detail-multi", f"/customers/{I['customer']}/"), ("customer-detail-loanless", f"/customers/{I['loanless']}/"),
                ("customer-detail-dense", f"/customers/{I['dense']}/"), ("customer-new", "/customers/new/"), ("customer-edit", f"/customers/{I['customer']}/edit/"),
                ("import", "/import/"), ("collections", "/collections/"), ("collections-failed", "/collections/?filter=failed"),
                ("collections-hold", "/collections/?filter=hold"), ("collections-empty", "/collections/?q=zzzz-no-match"),
                ("payments", "/payments/"), ("payments-unknown", "/payments/?filter=unknown"), ("payments-new", "/payments/new/"),
                ("payment-detail", f"/payments/{I['req']}/"), ("reviews", "/reviews/"), ("reviews-overdue", "/reviews/?filter=overdue"),
                ("review-detail", f"/reviews/{I['review']}/"), ("refund-new", f"/refunds/{I['payment']}/new/"),
                ("reports", "/reports/"), ("settings", "/settings/"), ("credit-future", "/credit/"), ("cash-future", "/cash/"),
                ("missing-404", "/customers/999999/"),
            ]
            public = [
                ("landing", "/"), ("request-demo", "/request-demo/"),
                ("borrower-consent-valid", "/consent/" + I["consent_valid"] + "/"),
                ("borrower-consent-withdrawn", "/consent/" + I["consent_withdrawn"] + "/"),
                ("borrower-consent-invalid", "/consent/not-a-real-token/"),
                ("borrower-pay-valid", "/pay/" + I["pay_Awaiting approval"] + "/"),
            ] + [("borrower-pay-" + k[4:].replace(" ", "-").lower(), "/pay/" + v + "/") for k, v in I.items() if k.startswith("pay_") and k != "pay_Awaiting approval"]
            auth = [
                ("signin", "/access/login/"), ("access-help", "/access/help/"), ("reset-request", "/access/reset/"),
                ("reset-invalid", "/access/reset/invalid-or-expired/"), ("invite-invalid", "/access/invitation/invalid-or-revoked/"),
                ("challenge-no-session", "/access/challenge/"), ("enrol-no-session", "/access/enrol/"), ("fresh-no-session", "/access/fresh/"),
                ("organisations-no-session", "/access/organisations/"), ("workspace-anon", "/access/workspace/"),
            ]

            def shoot(name, path, pg, kind):
                for w in SHOT_WIDTHS:
                    pg.set_viewport_size({"width": w, "height": 900})
                    r = pg.goto(base + path); pg.wait_for_timeout(150)
                    pg.evaluate("""()=>{const re=/\/(consent|pay)\/[A-Za-z0-9_-]{20,}\/?/g;
                      document.querySelectorAll('input,textarea').forEach(i=>{if(re.test(i.value))i.value=i.value.replace(re,'/$1/[token redacted]/');re.lastIndex=0});
                      document.querySelectorAll('a[href]').forEach(a=>{a.href=a.getAttribute('href').replace(re,'/$1/[redacted]/')});
                      const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){if(re.test(n.nodeValue)){n.nodeValue=n.nodeValue.replace(re,'/$1/[token redacted]/')}re.lastIndex=0}}""")
                    leak = pg.evaluate("""()=>{const re=/\/(consent|pay)\/[A-Za-z0-9_-]{20,}/;return [...document.querySelectorAll('input,textarea')].some(i=>re.test(i.value))||re.test(document.body.innerText)}""")
                    assert not leak, f"token visible before screenshot on {name}"
                    f = f"{PHASE}/{name}-{w}.png"
                    pg.screenshot(path=str(OUT / f), full_page=True)
                    manifest.append({"phase": PHASE, "state": name, "route": path if "/consent/" not in path and "/pay/" not in path else path.split("/")[1] + "/<token>/",
                                     "kind": kind, "viewport": w, "status": r.status if r else None, "file": f})
                if PHASE == "after":
                    cdp = pg.context.new_cdp_session(pg); cdp.send("Network.enable"); cdp.send("Network.setCacheDisabled", {"cacheDisabled": True})
                    tot = {"b": 0}; cb = lambda e: tot.__setitem__("b", tot["b"] + e["encodedDataLength"])
                    cdp.on("Network.loadingFinished", cb); pg.goto(base + path); pg.wait_for_load_state("networkidle")
                    budget = 100000 if name.startswith("borrower") else 500000 if name in ("landing", "request-demo") else 300000
                    weights.append({"state": name, "kind": kind, "bytes": tot["b"], "budget": budget, "pass": tot["b"] < budget})
                    cdp.detach()
                    for w in REFLOW_WIDTHS:
                        pg.set_viewport_size({"width": w, "height": 900}); pg.goto(base + path)
                        m = pg.evaluate("""()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,
                          ell:[...document.querySelectorAll('.num,.money')].filter(e=>getComputedStyle(e).textOverflow==='ellipsis'&&e.scrollWidth>e.clientWidth).length,
                          navTop:(document.querySelector('#main')||document.body).getBoundingClientRect().top})""")
                        reflow.append({"state": name, "width": w, "overflow_px": m["sw"] - m["cw"], "money_ellipsis": m["ell"], "main_top_px": round(m["navTop"])})

            if ONLY == "scenarios": staff = public = auth = []
            for n, pth in staff:
                shoot(n, pth, page, "real-route demo session (disposable test DB)")
            if PHASE == "after":
                page.set_viewport_size({"width": 360, "height": 850}); page.goto(base + "/customers/")
                checks = {"panel_hidden_initially": not page.locator(".nav").is_visible()}
                t = page.locator(".menu-toggle"); t.click()
                checks["expanded_after_click"] = t.get_attribute("aria-expanded")
                checks["focus_on_first_link"] = page.evaluate("document.activeElement.textContent.trim()")
                page.screenshot(path=str(OUT / "after/mobile-nav-open-360.png"), full_page=False)
                page.keyboard.press("Escape")
                checks["collapsed_after_escape"] = t.get_attribute("aria-expanded")
                checks["focus_returned_to_toggle"] = page.evaluate("document.activeElement.classList.contains('menu-toggle')")
                t.click()
                page.locator("details.acct > summary").click()
                checks["account_link_visible_when_details_opened_programmatically"] = page.get_by_role("link", name="Settings").is_visible()
                checks["main_top_px_collapsed"] = None
                page.locator("details.acct").evaluate("(n)=>n.open=false"); page.reload()
                checks["main_top_px_collapsed"] = round(page.evaluate("document.querySelector('#main').getBoundingClientRect().top"))
                json.dump(checks, open(OUT / "mobile-nav-checks.json", "w"), indent=1)
            anon = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce").new_page()
            for n, pth in public + auth:
                shoot(n, pth, anon, "real-route anonymous (disposable test DB)")
            # Actual protected staff views with isolated fixture account. Code/password fields are never captured filled.
            from django_otp.oath import totp
            st = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce").new_page()
            st.goto(base + "/access/login/"); st.get_by_label("Email", exact=True).fill("capture-admin@example.invalid")
            st.get_by_label("Password", exact=True).fill("wrong-" + STAFF_PW); st.locator("[data-access-form] button[type=submit]").click()
            st.get_by_label("Password", exact=True).fill("")
            st.screenshot(path=str(OUT / f"{PHASE}/auth-signin-invalid-generic-1440.png"), full_page=True)
            manifest.append({"phase": PHASE, "state": "auth-signin-invalid-generic", "route": "/access/login/ POST", "kind": "real protected route, isolated staff fixture", "viewport": 1440, "file": f"{PHASE}/auth-signin-invalid-generic-1440.png"})
            st.get_by_label("Email", exact=True).fill("capture-admin@example.invalid"); st.get_by_label("Password", exact=True).fill(STAFF_PW)
            st.locator("[data-access-form] button[type=submit]").click(); st.wait_for_load_state()
            st.screenshot(path=str(OUT / f"{PHASE}/auth-challenge-empty-1440.png"), full_page=True)
            manifest.append({"phase": PHASE, "state": "auth-challenge-empty", "route": st.url.replace(base, ""), "kind": "real protected route, isolated staff fixture", "viewport": 1440, "file": f"{PHASE}/auth-challenge-empty-1440.png"})
            st.get_by_label("Code", exact=True).fill("000000"); st.locator("[data-access-form] button[type=submit]").click(); st.wait_for_load_state()
            st.get_by_label("Code", exact=True).fill("")
            st.screenshot(path=str(OUT / f"{PHASE}/auth-challenge-invalid-1440.png"), full_page=True)
            manifest.append({"phase": PHASE, "state": "auth-challenge-invalid", "route": "/access/challenge/ POST", "kind": "real protected route, isolated staff fixture", "viewport": 1440, "file": f"{PHASE}/auth-challenge-invalid-1440.png"})
            import time as _t; _t.sleep(31)
            st.get_by_label("Code", exact=True).fill(str(totp(I["totp_key"])).zfill(6)); st.locator("[data-access-form] button[type=submit]").click(); st.wait_for_load_state()
            for n, pth in [("auth-organisations-multi", "/access/organisations/")]:
                shoot(n, pth, st, "real protected route, isolated staff fixture")
            if st.locator("select[name=organisation]").count():
                v = st.locator("select[name=organisation] option", has_text="Meridian").first.get_attribute("value")
                st.locator("select[name=organisation]").select_option(v); st.locator("[data-access-form] button[type=submit]").click(); st.wait_for_load_state()
            for n, pth in [("staff-today", "/today/"), ("staff-workspace", "/access/workspace/"), ("staff-access-settings", "/access/settings/"),
                           ("staff-invitations", "/access/invitations/"), ("staff-fresh", "/access/fresh/"), ("staff-customer-dense", f"/customers/{I['dense']}/")]:
                shoot(n, pth, st, "real protected route, isolated staff fixture")

            # ===== Interactive POST/lifecycle scenarios on actual routes (disposable DB) =====
            from django.core import mail
            import re as _re
            MASK = "#setup-key, [data-copy-status], details a[href^='otpauth']"
            def snap(name, pg, kind, route, note=""):
                pg.evaluate("""()=>{const re=/\\/(consent|pay|access\\/invitation|access\\/reset)\\/[A-Za-z0-9_:.-]{16,}/g;
                  document.querySelectorAll('input,textarea').forEach(i=>{if(i.id==='setup-key'){i.value='[setup key redacted]'}else if(i.type!=='password'&&i.name!=='code'&&i.name!=='otp_token'){i.value=i.value.replace(re,'/$1/[redacted]')}});
                  const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){n.nodeValue=n.nodeValue.replace(re,'/$1/[redacted]')}}""")
                for w in SHOT_WIDTHS:
                    pg.set_viewport_size({"width": w, "height": 900}); pg.wait_for_timeout(120)
                    f = f"{PHASE}/{name}-{w}.png"
                    pg.screenshot(path=str(OUT / f), full_page=True, mask=[pg.locator(MASK)], mask_color="#5C6573")
                    manifest.append({"phase": PHASE, "state": name, "route": route, "kind": kind, "viewport": w, "file": f, "note": note})
                pg.set_viewport_size({"width": 1440, "height": 900})
            DEMO = "real-route POST/state, demo session (disposable test DB)"
            STAFF = "real protected route, isolated staff fixture"
            sub = lambda pg: pg.locator("[data-access-form] button[type=submit]").click()
            # --- import states
            hdr = "customer_id,name,email,phone,loan_id,product,amount,due_date\n"
            page.goto(base + "/import/")
            page.locator("#csv_data").fill(hdr + "VC-1,Bad Row,not-an-email,,VC-L1,Test,12x.50,2027-13-40\nVC-2,,b@example.invalid,,VC-L2,Test,-5,2027-01-01")
            page.get_by_role("button", name="Validate rows", exact=True).click(); page.wait_for_load_state()
            snap("import-row-errors", page, DEMO, "/import/ POST validate (invalid)")
            good = hdr + "\n".join(f"VC-{n},Adaeze Synthetic {n},vc{n}@example.invalid,,VC-L{n},Personal finance,{12345 + n}.50,2027-0{1 + n % 8}-15" for n in range(3, 9))
            page.goto(base + "/import/"); page.locator("#csv_data").fill(good)
            page.get_by_role("button", name="Validate rows", exact=True).click(); page.wait_for_load_state()
            snap("import-valid-preview", page, DEMO, "/import/ POST validate (valid preview receipt)")
            from core.models import ImportPreview
            self.db(lambda: ImportPreview.objects.filter(consumed_at__isnull=True).update(expires_at=timezone.now() - timedelta(minutes=1)))
            page.get_by_role("button", name=_re.compile("^Import ")).click(); page.wait_for_load_state()
            snap("import-expired-preview", page, DEMO, "/import/ POST commit (expired receipt)")
            page.goto(base + "/import/"); page.locator("#csv_data").fill(good)
            page.get_by_role("button", name="Validate rows", exact=True).click(); page.wait_for_load_state()
            form_html = page.evaluate("()=>{const f=[...document.forms].find(f=>f.querySelector('[name=preview_id]'));return {pid:f.querySelector('[name=preview_id]').value}}")
            page.get_by_role("button", name=_re.compile("^Import ")).click(); page.wait_for_load_state()
            snap("import-confirmed", page, DEMO, "/import/ POST commit -> /customers/ success")
            page.goto(base + "/import/")
            with page.expect_navigation():
              page.evaluate("""([pid,t])=>{const f=document.createElement('form');f.method='post';f.action='/import/';
              const c=document.querySelector('[name=csrfmiddlewaretoken]').cloneNode();f.append(c);
              for(const [k,v] of [['csv_data',t],['action','commit'],['preview_id',pid]]){const i=document.createElement('input');i.type='hidden';i.name=k;i.value=v;f.append(i)}
              document.body.append(f);f.submit()}""", [form_html["pid"], good])
            page.wait_for_load_state()
            snap("import-reused-preview", page, DEMO, "/import/ POST commit (already-used receipt replay)")
            # --- pay-by-bank cancellation confirmation + result
            page.goto(base + "/payments/")
            dialog = {}
            def on_dialog(d):
                dialog["message"] = d.message; d.accept()
            page.once("dialog", on_dialog)
            cancel = page.locator("form[action$='/cancel/'] button").first
            if cancel.count():
                page.locator("form[action$='/cancel/']").first.evaluate("f=>f.closest('tr').style.outline='3px solid #BA390C'")
                snap("payments-cancel-target", page, DEMO, "/payments/ (row about to be cancelled)", note="native confirm() cannot be screenshotted")
                cancel.click(); page.wait_for_load_state()
                snap("payments-cancel-result", page, DEMO, "/payments/<pk>/cancel/ POST result", note="confirm text: " + dialog.get("message", ""))
            # --- refund submission attempt (gates)
            pay_pk = I["payment"]
            page.goto(base + f"/refunds/{pay_pk}/new/")
            snap("refund-blocked", page, DEMO, "/refunds/<pk>/new/ (calendar gate / independent reviewer)")
            # --- borrower recovery (expired/invalid -> recovery shell)
            anon.goto(base + "/pay/not-a-real-token/"); snap("borrower-recovery-invalid", anon, "real-route anonymous", "/pay/<invalid>/ -> recovery")
            # --- staff lifecycle: invitations
            st.goto(base + "/access/invitations/")
            snap("auth-invitations-empty", st, STAFF, "/access/invitations/")
            st.get_by_label("Email", exact=True).fill("capture-new@example.invalid"); st.get_by_label("Role", exact=True).select_option("Preparer"); sub(st); st.wait_for_load_state()
            snap("auth-invitation-issued", st, STAFF, "/access/invitations/ POST")
            invite = _re.search(r"/access/invitation/[^/\s]+/", mail.outbox[-1].body).group()
            st.goto(base + "/access/invitations/"); st.get_by_label("Email", exact=True).fill("capture-revoke@example.invalid"); st.get_by_label("Role", exact=True).select_option("Viewer"); sub(st); st.wait_for_load_state()
            revoked_link = _re.search(r"/access/invitation/[^/\s]+/", mail.outbox[-1].body).group()
            st.goto(base + "/access/invitations/"); snap("auth-invitations-pending", st, STAFF, "/access/invitations/ (two pending)")
            st.once("dialog", lambda d: d.accept())
            st.get_by_role("button", name="Revoke invitation for capture-revoke@example.invalid").click(); st.wait_for_load_state()
            snap("auth-invitation-revoked-result", st, STAFF, "/access/invitations/<pk>/revoke/ POST")
            # idle warning on a real staff page
            st.clock.install(); st.goto(base + "/today/"); st.clock.fast_forward(1681000); st.wait_for_timeout(300)
            snap("auth-idle-warning", st, STAFF, "/today/ idle warning (browser clock advanced)")
            # denied: fresh sign-in, choose the Viewer membership by its stable option value
            import time as _tm
            from django_otp.oath import totp as _tp
            _tm.sleep(31 - (_tm.time() % 30) + 1)
            dn = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce").new_page()
            dn.goto(base + "/access/login/"); dn.get_by_label("Email", exact=True).fill("capture-admin@example.invalid"); dn.get_by_label("Password", exact=True).fill(STAFF_PW); sub(dn); dn.wait_for_load_state()
            dn.get_by_label("Code", exact=True).fill(str(_tp(I["totp_key"])).zfill(6)); sub(dn); dn.wait_for_load_state()
            opt = dn.locator("select[name=organisation] option", has_text="Second Synthetic").first.get_attribute("value")
            dn.locator("select[name=organisation]").select_option(opt); sub(dn); dn.wait_for_load_state()
            r = dn.goto(base + "/customers/new/"); snap("auth-denied-viewer", dn, STAFF, f"/customers/new/ as Viewer ({r.status})")
            r = dn.goto(base + "/exports/audit/"); snap("auth-denied-audit-export", dn, STAFF, f"/exports/audit/ as Viewer ({r.status})")
            dn.goto(base + "/today/"); snap("auth-viewer-today", dn, STAFF, "/today/ as Viewer (read-only notice)")
            dn.context.close()
            # invited person accepts + sets up authenticator
            nw = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce").new_page()
            nw.goto(base + invite); snap("auth-invite-accept", nw, "real-route anonymous, isolated invite", "/access/invitation/<raw>/")
            nw.get_by_label("Password", exact=True).fill("short"); nw.get_by_label("Confirm password", exact=True).fill("different"); sub(nw); nw.wait_for_load_state()
            nw.get_by_label("Password", exact=True).fill(""); nw.get_by_label("Confirm password", exact=True).fill("")
            snap("auth-invite-password-errors", nw, "real-route anonymous, isolated invite", "/access/invitation/<raw>/ POST invalid")
            nw.get_by_label("Password", exact=True).fill(STAFF_PW); nw.get_by_label("Confirm password", exact=True).fill(STAFF_PW); sub(nw); nw.wait_for_load_state()
            snap("auth-enrol-setup", nw, "real protected route, setup key masked", "/access/enrol/")
            nw.get_by_label("Code", exact=True).fill("000000"); sub(nw); nw.wait_for_load_state(); nw.get_by_label("Code", exact=True).fill("")
            snap("auth-enrol-invalid-code", nw, "real protected route, setup key masked", "/access/enrol/ POST invalid")
            from django.contrib.auth import get_user_model
            from django_otp.plugins.otp_totp.models import TOTPDevice
            from django_otp.oath import totp as _totp
            key = self.db(lambda: TOTPDevice.objects.get(user__username="capture-new@example.invalid").bin_key)
            nw.get_by_label("Code", exact=True).fill(str(_totp(key)).zfill(6)); sub(nw); nw.wait_for_load_state()
            snap("auth-enrol-complete", nw, STAFF, nw.url.replace(base, ""))
            nw.context.close()
            an2 = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce").new_page()
            an2.goto(base + invite); snap("auth-invite-reused", an2, "real-route anonymous", "/access/invitation/<used>/")
            an2.goto(base + revoked_link); snap("auth-invite-revoked", an2, "real-route anonymous", "/access/invitation/<revoked>/")
            # reset lifecycle
            an2.goto(base + "/access/reset/"); an2.get_by_label("Email", exact=True).fill("capture-admin@example.invalid"); sub(an2); an2.wait_for_load_state()
            snap("auth-reset-requested-generic", an2, "real-route anonymous", "/access/reset/ POST")
            reset = _re.search(r"/access/reset/[^/\s]+/", mail.outbox[-1].body).group()
            an2.goto(base + reset); snap("auth-reset-form", an2, "real-route anonymous, isolated reset", "/access/reset/<raw>/")
            an2.get_by_label("Password", exact=True).fill("aaa"); an2.get_by_label("Confirm password", exact=True).fill("bbb"); sub(an2); an2.wait_for_load_state()
            an2.get_by_label("Password", exact=True).fill(""); an2.get_by_label("Confirm password", exact=True).fill("")
            snap("auth-reset-errors", an2, "real-route anonymous, isolated reset", "/access/reset/<raw>/ POST invalid")
            np = STAFF_PW + "x"
            an2.get_by_label("Password", exact=True).fill(np); an2.get_by_label("Confirm password", exact=True).fill(np); sub(an2); an2.wait_for_load_state()
            snap("auth-reset-complete", an2, "real-route anonymous, isolated reset", "/access/reset/<raw>/ POST valid")
            an2.goto(base + reset); snap("auth-reset-reused", an2, "real-route anonymous", "/access/reset/<used>/")
            an2.context.close()
            # no-membership account
            nm = browser.new_context(viewport={"width": 1440, "height": 900}, reduced_motion="reduce").new_page()
            nm.goto(base + "/access/login/"); nm.get_by_label("Email", exact=True).fill("capture-nomember@example.invalid"); nm.get_by_label("Password", exact=True).fill(STAFF_PW); sub(nm); nm.wait_for_load_state()
            nm.get_by_label("Code", exact=True).fill(str(_totp(I["nomem_key"])).zfill(6)); sub(nm); nm.wait_for_load_state()
            snap("auth-no-membership", nm, STAFF, nm.url.replace(base, ""))
            nm.context.close()
            # revoked membership while signed in
            from core.models import StaffMembership
            self.db(lambda: StaffMembership.objects.filter(user__username="capture-admin@example.invalid").update(active=False))
            st.clock.resume() if hasattr(st.clock, "resume") else None
            r = st.goto(base + "/today/"); snap("auth-membership-revoked", st, STAFF, f"/today/ after membership deactivated ({r.status})")
            if PHASE == "after":
                # In-memory design fixtures: actual templates, separate from real-route evidence.
                for f in ("dense", "empty", "long", "large"):
                    shoot(f"fixture-today-{f}", f"/__design/today/?fixture={f}", anon, "in-memory fixture (not real-route evidence)")
                shoot("fixture-components", "/__design/", anon, "in-memory fixture (not real-route evidence)")
            browser.close()
        json.dump(manifest, open(OUT / f"manifest-{PHASE}.json", "w"), indent=1)
        if PHASE == "after":
            json.dump(reflow, open(OUT / "reflow.json", "w"), indent=1)
            json.dump(weights, open(OUT / "weights.json", "w"), indent=1)
        print("captured", len(manifest))
