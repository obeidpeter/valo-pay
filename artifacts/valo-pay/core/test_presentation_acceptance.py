"""Focused presentation acceptance (TRD 8.3 badges, narrow long+large rows, desktop account reach).

Isolated: StaticLiveServerTestCase creates and destroys its own test database. No business data,
providers, messages or production routes are touched. Captures go to evidence/presentation-acceptance/.
Set VALO_PRESENTATION_PHASE=before to capture without asserting (used once before editing).
"""
import json
import os
import shutil
from datetime import date, timedelta
from pathlib import Path

from django.contrib.staticfiles.testing import StaticLiveServerTestCase
from django.test import override_settings
from core.content import STATE_LABEL
from django.utils import timezone

from .models import Customer, Instalment, Loan, Member, Organisation, Payment, PaymentRequest, Review

BIG = 123456789012345  # kobo -> ₦1,234,567,890,123.45
BIG_TEXT = "₦1,234,567,890,123.45"
LONG = "Oluwadamilare Chukwuemekanwaneri-Adebayo-Okonkwo Synthetic Holdings"
PHASE = os.environ.get("VALO_PRESENTATION_PHASE", "after")
OUT = Path("evidence/presentation-acceptance") / PHASE

# TRD 8.3 (read at the actual section, not first mention): word -> (tone, icon)
TRD_83 = {
    "Active": ("ok", "tick"), "Confirmed": ("ok", "tick"),
    "Refunded": ("neutral", "return"), "Failed": ("err", "cross"), "Reversed": ("err", "return"),
    "Unknown": ("warn", "question"), "On hold": ("warn", "pause"),
    "Awaiting approval": ("neutral", "clock"), "Awaiting confirmation": ("neutral", "clock"),
    "Awaiting bank": ("neutral", "clock"), "Sent": ("neutral", "clock"), "Processing": ("neutral", "clock"),
    "Withdrawn": ("neutral", "dash"), "Expired": ("neutral", "dash"), "Cancelled": ("neutral", "dash"),
    "Overdue": ("err", "exclaim"),
    "Upcoming": ("neutral", "dot"), "Due": ("info", "dot"), "Paid": ("ok", "dot"), "Part-paid": ("warn", "dot"),
    "Open": ("warn", "dot"), "In progress": ("info", "dot"), "Resolved": ("ok", "dot"), "Dismissed": ("neutral", "dot"),
}

CONTRAST_JS = """(sel)=>{
 function rgb(s){const m=s.match(/[\\d.]+/g).map(Number);return m}
 function lum(c){const a=c.slice(0,3).map(v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)});return .2126*a[0]+.7152*a[1]+.0722*a[2]}
 function ratio(a,b){const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
 return [...document.querySelectorAll(sel)].map(b=>{const cs=getComputedStyle(b);const svg=b.querySelector('svg');
  const bg=rgb(cs.backgroundColor),fg=rgb(cs.color),ic=svg?rgb(getComputedStyle(svg).color):fg;
  return {word:b.textContent.trim(),tone:b.dataset.tone,icon:b.dataset.icon,text:+ratio(fg,bg).toFixed(2),icon_ratio:+ratio(ic,bg).toFixed(2),
   icon_hidden:svg?svg.getAttribute('aria-hidden'):null}})}"""


@override_settings(SESSION_COOKIE_SECURE=False, CSRF_COOKIE_SECURE=False, CONN_MAX_AGE=0)
class PresentationAcceptanceTests(StaticLiveServerTestCase):
    def setUp(self):
        now = timezone.now()
        self.org = Organisation.objects.create(name="Isolated presentation synthetic")
        self.actor = Member.objects.create(organisation=self.org, name="Synthetic Admin With A Long Name", role="Admin")
        other = Member.objects.create(organisation=self.org, name="Synthetic Reviewer", role="Reviewer")
        s = self.client.session
        s.update({"org": str(self.org.pk), "actor": self.actor.pk, "demo_mode": True})
        s.save()
        self.session = self.client.cookies["sessionid"].value
        self.customer = Customer.objects.create(organisation=self.org, name=LONG, external_id="PRESENTATION-LONG-EXTERNAL-ID-0001")
        self.loan = Loan.objects.create(organisation=self.org, customer=self.customer, reference="PRES-LOAN-LONG-REFERENCE-000000001",
                                        status="Active", consent_status="Active", consent_max=BIG, consent_expiry=date(2030, 1, 1),
                                        consent_token="isolated-presentation-token", consent_requested_at=now)
        self.inst = Instalment.objects.create(organisation=self.org, loan=self.loan, sequence=1, amount=BIG,
                                              due_date=timezone.localdate(), state="Due")
        Instalment.objects.create(organisation=self.org, loan=self.loan, sequence=2, amount=BIG,
                                  due_date=timezone.localdate() - timedelta(days=9), state="Overdue")
        self.review = Review.objects.create(organisation=self.org, instalment=self.inst, kind="Unknown result", amount=BIG,
                                            owner=other, prepared_by=self.actor, deadline=now - timedelta(hours=3),
                                            evidence="Synthetic isolated evidence; provider returned no final status in time.")
        self.payment = Payment.objects.create(organisation=self.org, instalment=self.inst, reference="PAY-PRESENTATION-LONG-REF-0000000001",
                                              amount=BIG, status="Confirmed", paid_at=now)
        self.request = PaymentRequest.objects.create(organisation=self.org, instalment=self.inst, reference="PR-PRESENTATION-LONG-REF-0000001",
                                                     amount=BIG, status="Awaiting approval", expires_at=now + timedelta(days=2))

    def _ctx(self, browser, w, h):
        ctx = browser.new_context(viewport={"width": w, "height": h})
        ctx.add_cookies([{"name": "sessionid", "value": self.session, "url": self.live_server_url}])
        return ctx

    def _mask(self, page):
        page.locator("[data-abs]").evaluate_all("(n)=>n.forEach(x=>x.value='[synthetic link redacted]')")

    def _check(self, cond, msg, problems):
        if not cond:
            problems.append(msg)

    def test_presentation_acceptance(self):
        from playwright.sync_api import sync_playwright
        OUT.mkdir(parents=True, exist_ok=True)
        report, problems = {"phase": PHASE, "routes": [], "desktop": [], "badges": None}, []
        routes = [("today", "/today/"), ("customer", f"/customers/{self.customer.pk}/"),
                  ("review", f"/reviews/{self.review.pk}/"), ("reviews", "/reviews/"),
                  ("payments", "/payments/"), ("payment-request", f"/payments/{self.request.pk}/")]
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=shutil.which("chromium"))
            for w in (320, 390):
                ctx = self._ctx(browser, w, 900)
                page = ctx.new_page()
                for label, path in routes:
                    r = page.goto(self.live_server_url + path)
                    page.wait_for_load_state("networkidle")
                    m = page.evaluate("""(big)=>{
                      const sw=document.documentElement.scrollWidth;
                      const amts=[...document.querySelectorAll('main *')].filter(e=>e.children.length===0&&e.textContent.includes(big)).map(e=>{const r=e.getBoundingClientRect();return {w:Math.round(r.width),right:Math.round(r.right),clipped:e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflow!=='visible'}});
                      const metas=[...document.querySelectorAll('.rows .t2')].map(e=>Math.round(e.getBoundingClientRect().width));
                      return {scrollWidth:sw,amounts:amts,meta_widths:metas,abbrev:/₦\\s?[\\d.]+\\s?(tn|bn|T|B|M)\\b/.test(document.body.innerText),hasLong:document.body.innerText.includes('Oluwadamilare')}}""", BIG_TEXT)
                    m.update(route=label, width=w, status=r.status)
                    report["routes"].append(m)
                    self._check(r.status == 200, f"{label}@{w} status {r.status}", problems)
                    self._check(m["scrollWidth"] <= w, f"{label}@{w} horizontal overflow {m['scrollWidth']}", problems)
                    self._check(m["amounts"], f"{label}@{w} full amount missing", problems)
                    self._check(all(a["right"] <= w and not a["clipped"] for a in m["amounts"]), f"{label}@{w} amount clipped", problems)
                    self._check(not m["abbrev"], f"{label}@{w} abbreviated amount", problems)
                    inner = w - 24 * 2
                    self._check(all(x >= inner - 60 for x in m["meta_widths"]), f"{label}@{w} metadata squeezed {m['meta_widths']}", problems)
                    self._mask(page)
                    page.screenshot(path=str(OUT / f"{label}-{w}.png"), full_page=True)
                ctx.close()
            # desktop / short height / zoom-equivalent sidebar reach
            for vw, vh, tag in ((1440, 1000, "desktop"), (1440, 600, "short"), (720, 500, "zoom200")):
                ctx = self._ctx(browser, vw, vh)
                page = ctx.new_page()
                page.goto(self.live_server_url + f"/customers/{self.customer.pk}/")
                page.wait_for_load_state("networkidle")
                # The six product pages; Settings and the previews sit in their own sidebar group.
                navs = page.locator('nav[aria-label="Main"] a').count()
                if vw <= 900:
                    page.locator(".menu-toggle").click()
                summary = page.locator(".acct summary")
                box = summary.bounding_box()
                d = {"viewport": [vw, vh], "nav_items": navs, "summary_y_load": round(box["y"]) if box else None}
                # keyboard: Tab until account summary focused, open with Enter, Tab to Settings
                page.keyboard.press("Escape") if False else None
                page.evaluate("document.activeElement&&document.activeElement.blur()")
                for _ in range(40):
                    page.keyboard.press("Tab")
                    if page.evaluate("document.activeElement&&document.activeElement.matches('.acct summary')"):
                        break
                d["summary_focused"] = page.evaluate("document.activeElement.matches('.acct summary')")
                page.keyboard.press("Enter")
                page.keyboard.press("Tab")
                d["role_switch_focused"] = page.evaluate("document.activeElement.getAttribute('href')") == "/settings/#role"
                d["role_switch_visible"] = page.evaluate("""()=>{const a=document.querySelector('.acct a[href="/settings/#role"]');const r=a.getBoundingClientRect();
                  const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return r.top>=0&&r.bottom<=innerHeight&&!!hit&&a.contains(hit)}""")
                d["settings_in_sidebar"] = page.evaluate("""()=>{const a=document.querySelector('nav[aria-label="Organisation"] a[href="/settings/"]');
                  if(!a)return false;const r=a.getBoundingClientRect();return r.width>0&&r.height>0}""")
                d["demo_identity"] = "Synthetic Admin" in page.inner_text(".acct summary")
                d["menu_state_kept"] = (vw > 900) or page.get_attribute(".menu-toggle", "aria-expanded") == "true"
                report["desktop"].append(d)
                self._check(navs == 6, f"{tag} nav count {navs}", problems)
                if tag == "desktop":
                    self._check(d["summary_y_load"] is not None and box["y"] + box["height"] <= vh, f"desktop summary at y{d['summary_y_load']}", problems)
                for k in ("summary_focused", "role_switch_focused", "role_switch_visible", "settings_in_sidebar", "demo_identity", "menu_state_kept"):
                    self._check(d[k], f"{tag} {k} failed", problems)
                self._mask(page)
                page.screenshot(path=str(OUT / f"account-open-{tag}-{vw}x{vh}.png"))
                ctx.close()
            # badge mapping rendered from the real include on the design review surface
            ctx = self._ctx(browser, 1280, 900)
            page = ctx.new_page()
            r = page.goto(self.live_server_url + "/__design/")
            if r.status == 200:
                page.wait_for_load_state("networkidle")
                badges = page.evaluate(CONTRAST_JS, "#status-matrix .badge")
                report["badges"] = badges
                seen = {b["word"]: b for b in badges}
                for word, (tone, icon) in TRD_83.items():
                    # Badges show the plain name where the owner chose one (Unknown reads "Result not known").
                    b = seen.get(STATE_LABEL.get(word, word))
                    self._check(b and b["tone"] == tone and b["icon"] == icon, f"badge {word} mapping {b}", problems)
                    if b:
                        self._check(b["text"] >= 4.5 and b["icon_ratio"] >= 3 and b["icon_hidden"] == "true", f"badge {word} contrast {b}", problems)
                loc = page.locator("#status-matrix")
                if loc.count():
                    loc.screenshot(path=str(OUT / "badge-matrix.png"))
            else:
                problems.append(f"design-review status {r.status}")
            ctx.close()
            # borrower status badge (public page) shares icon language
            ctx = browser.new_context(viewport={"width": 390, "height": 900})
            page = ctx.new_page()
            page.goto(self.live_server_url + "/consent/isolated-presentation-token/")
            page.wait_for_load_state("networkidle")
            self._mask(page)
            page.screenshot(path=str(OUT / "borrower-consent-390.png"), full_page=True)
            report["borrower_svg_hidden"] = page.evaluate("[...document.querySelectorAll('.st svg, .badge svg')].every(s=>s.getAttribute('aria-hidden')==='true')")
            ctx.close()
            browser.close()
        report["problems"] = problems
        (OUT / "report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False))
        if PHASE != "before":
            self.assertEqual(problems, [])

    def test_selected_payload_budgets(self):
        """Cold, cache-disabled transfer for the heaviest selected staff route and the borrower route."""
        from playwright.sync_api import sync_playwright
        OUT.mkdir(parents=True, exist_ok=True)
        routes = [("borrower-consent", "/consent/isolated-presentation-token/", 100000, False),
                  ("customer-detail", f"/customers/{self.customer.pk}/", 300000, True),
                  ("today", "/today/", 300000, True)]
        results = []
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=shutil.which("chromium"))
            for label, path, budget, staff in routes:
                ctx = self._ctx(browser, 390, 900) if staff else browser.new_context(viewport={"width": 390, "height": 900})
                page = ctx.new_page()
                cdp = ctx.new_cdp_session(page)
                cdp.send("Network.enable")
                cdp.send("Network.setCacheDisabled", {"cacheDisabled": True})
                sizes = []
                page.on("requestfinished", lambda req: sizes.append(req.sizes()["responseBodySize"] + req.sizes()["responseHeadersSize"]))
                page.goto(self.live_server_url + path)
                page.wait_for_load_state("networkidle")
                page.evaluate("document.fonts.ready")
                family = page.evaluate("getComputedStyle(document.body).fontFamily")
                loaded = page.evaluate("[...document.fonts].some(f=>f.family.includes('Jakarta')&&f.status==='loaded')")
                results.append({"route": label, "bytes_including_headers": sum(sizes), "requests": len(sizes), "budget": budget,
                                "font_family": family, "jakarta_loaded": loaded})
                ctx.close()
            browser.close()
        (OUT / "payload.json").write_text(json.dumps(results, indent=1))
        for r in results:
            self.assertLess(r["bytes_including_headers"], r["budget"], r)
            self.assertTrue(r["jakarta_loaded"], r)
