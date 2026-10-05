"""Cold transfer checks for the maximum supported single-customer import."""
import json
import shutil
from pathlib import Path
from datetime import date
from django.utils import timezone
from django.contrib.staticfiles.testing import StaticLiveServerTestCase
from django.test import override_settings
from . import test_customer_paging


@override_settings(SESSION_COOKIE_SECURE=False, CSRF_COOKIE_SECURE=False, CONN_MAX_AGE=0)
class DenseBrowserBudgetTests(StaticLiveServerTestCase):
    def test_dense_cold_bytes(self):
        test_customer_paging.CustomerPagingTests.setUp(self)
        self.loan.consent_token = "isolated-dense-budget-token"
        self.loan.consent_status = "Requested"
        self.loan.consent_requested_at = timezone.now()
        self.loan.consent_expiry = date(2030, 1, 1)
        self.loan.save()
        session_cookie = self.client.cookies["sessionid"].value
        routes = [
            ("borrower-5000", f"/consent/{self.loan.consent_token}/", 100000),
            ("borrower-5000-last", f"/consent/{self.loan.consent_token}/?page=250", 100000),
            ("customer-5000", f"/customers/{self.customer.pk}/", 300000),
        ]
        from playwright.sync_api import sync_playwright
        out = Path("evidence/brochure-complete")
        out.mkdir(parents=True, exist_ok=True)
        results = []
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=shutil.which("chromium"))
            for label, path, budget in routes:
                ctx = browser.new_context(viewport={"width": 390, "height": 900})
                if label.startswith("customer"):
                    ctx.add_cookies([{"name": "sessionid", "value": session_cookie, "url": self.live_server_url}])
                page = ctx.new_page()
                cdp = ctx.new_cdp_session(page)
                cdp.send("Network.enable")
                cdp.send("Network.setCacheDisabled", {"cacheDisabled": True})
                sizes = []
                page.on("requestfinished", lambda req: sizes.append(req.sizes()["responseBodySize"] + req.sizes()["responseHeadersSize"]))
                response = page.goto(self.live_server_url + path)
                page.wait_for_load_state("networkidle")
                page.evaluate("document.fonts.ready")
                page.evaluate("""()=>{let s=document.createElement('span');s.id='glyph-proof';s.textContent='₦ỌẸọ 0123456789';s.style='position:absolute;left:-10000px;top:0;font-family:\"Plus Jakarta Sans\"';document.body.append(s)}""")
                page.evaluate("document.fonts.ready")
                page.wait_for_load_state("networkidle")
                cdp.send("DOM.enable")
                cdp.send("CSS.enable")
                root = cdp.send("DOM.getDocument")["root"]["nodeId"]
                node = cdp.send("DOM.querySelector", {"nodeId": root, "selector": "#glyph-proof"})["nodeId"]
                fonts = cdp.send("CSS.getPlatformFontsForNode", {"nodeId": node})["fonts"]
                self.assertTrue(fonts)
                self.assertTrue(all(f["isCustomFont"] and "Jakarta" in f["familyName"] for f in fonts), fonts)
                page.locator("#glyph-proof").evaluate("(node)=>node.remove()")
                total = sum(sizes)
                self.assertEqual(response.status, 200)
                self.assertIn("5000", page.inner_text("body"))
                self.assertLess(total, budget)
                self.assertLessEqual(page.evaluate("document.documentElement.scrollWidth"), 390)
                # Bearer links are never retained in screenshot content.
                page.locator("[data-abs]").evaluate_all("(nodes)=>nodes.forEach(n=>n.value='[synthetic link redacted]')")
                page.screenshot(path=str(out / f"{label}-390.png"), full_page=True)
                results.append({"state": label, "bytes_including_headers": total, "requests": len(sizes),
                                "budget": budget, "rows": 5000, "glyph_fonts": fonts,
                                "compression": response.headers.get("content-encoding", "identity")})
                ctx.close()
            ctx = browser.new_context(viewport={"width": 390, "height": 900})
            ctx.add_cookies([{"name": "sessionid", "value": session_cookie, "url": self.live_server_url}])
            page = ctx.new_page()
            page.goto(self.live_server_url + "/import/")
            csv = b"customer_id,name,email,phone,loan_id,product,amount,due_date\nVISUAL,Synthetic Upload,,,VISUAL-L,Test,18.50,2027-01-01"
            page.locator("#csv_file").set_input_files({"name": "synthetic.csv", "mimeType": "text/csv", "buffer": csv})
            from playwright.sync_api import expect
            expect(page.locator("#csv_data")).to_have_value(csv.decode())
            page.screenshot(path=str(out / "import-file-read-390.png"), full_page=True)
            requests = []
            def no_navigation_response(route):
                requests.append(route.request.method)
                route.fulfill(status=204)
            page.route("**/import/", no_navigation_response)
            page.get_by_role("button", name="Validate rows", exact=True).click(no_wait_after=True)
            # Controlled 204 keeps the document in place so its real busy
            # controls can be inspected; this is not backend progress evidence.
            expect(page.locator('button[aria-busy="true"]')).to_have_text("Submitting…")
            page.screenshot(path=str(out / "import-client-busy-390.png"), full_page=True)
            self.assertEqual(requests, ["POST"])
            ctx.close()
            browser.close()
        (out / "dense-final-weights.json").write_text(json.dumps({
            "environment": "isolated PostgreSQL test database, Chromium, localhost StaticLiveServer",
            "method": "new browser context per route; network cache disabled; HTML/assets/fonts plus response headers",
            "results": results,
        }, indent=2))