"""Copy checks: every page shows finished wording that follows docs/content/content-guide.md.

These read what a person sees or hears (text, page titles, accessible names, confirm dialogs),
not the markup, so they survive layout changes and fail on wording regressions.
"""
import csv
import io
import re
from html.parser import HTMLParser

from django.template.loader import render_to_string
from django.test import Client

from core import content
from core.models import Customer, Instalment, Payment, PaymentRequest, Review
from .base import WorkspaceTestCase

# Wording the guide rules out, with the reason shown when a check fails.
BANNED = [
    (r"\bNone\b|\bnan\b|undefined|\[object", "an empty value printed as text"),
    (r"(?i)sandbox", "say demo, not sandbox"),
    (r"(?i)synthetic|dummy data", "say sample data"),
    (r"(?i)two-factor|\b2FA\b", "say two-step verification"),
    (r"(?i)\blog ?in\b|\blogged in\b|signed in as", "the demo has no sign-in: say acting as"),
    (r"(?i)something went wrong|\binvalid\b|This field is required|Enter a valid", "a generic or default error message"),
    (r"(?i)\bsoon\b", "do not promise dates"),
    (r"(?i)secured by", "Valo Pay does not secure the customer's bank"),
    (r"(?i)\bexternal ID\b", "say customer ID or loan ID"),
    (r"(?i)\borganiz|\bauthoriz|\binstallment|\bcancel(?:ed|ing)\b|\blicense\b", "use British spelling"),
    (r"Pay by bank|Pay-By-Bank|Pay By Bank", "the canonical name is Pay-by-bank"),
    (r"\b(?:Administrator|Approver|Maker|Checker)\b", "the roles are Admin, Preparer, Reviewer and Viewer"),
    (r"(?i)\bsubmit\b|\bclick here\b", "buttons say what will happen"),
    (r"\b(?:can't|don't|won't|isn't|didn't|doesn't|wasn't|aren't|couldn't|shouldn't)\b", "avoid negative contractions"),
    (r"(?<![\w.,-])1 (?:instalments|customers|loans|items|payments|reviews|requests|days|hours|rows|problems|matches)\b", "1 takes a singular noun"),
    (r"(?<![\w.,₦-])(?:0|[2-9]|[1-9]\d+) (?:instalment|customer|loan|item|payment|review|request|day|hour|row|problem)\b(?! \d)", "a count above 1 takes a plural noun"),
]
NAVIGATION = ["Today", "Customers", "Collections", "Pay-by-bank", "Reviews", "Reports"]
ROLES = ["Admin", "Preparer", "Reviewer", "Viewer"]


class Reader(HTMLParser):
    """Collects visible text and accessible names, and notes form controls without a label."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.hidden, self.in_label, self.in_title = [], 0, 0, False
        self.title, self.h1, self.labelled, self.controls, self.buttons = "", 0, set(), [], []
        self.links, self.link = {}, None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("style", "script"):
            self.hidden += 1
        for key in ("aria-label", "title", "placeholder", "alt", "data-confirm"):
            if a.get(key):
                self.parts.append(a[key])
        if tag == "meta" and a.get("name") == "description":
            self.parts.append(a.get("content", ""))
        if tag == "title":
            self.in_title = True
        if tag == "h1":
            self.h1 += 1
        if tag == "label":
            self.in_label += 1
            if a.get("for"):
                self.labelled.add(a["for"])
        if tag in ("input", "select", "textarea") and a.get("type") not in ("hidden", "submit", "button"):
            if not (self.in_label or a.get("aria-label")):
                self.controls.append(a.get("id") or a.get("name"))
        if tag == "button":
            self.buttons.append([a.get("aria-label") or ""])
        if tag == "a" and a.get("href"):
            self.link = [a["href"], a.get("aria-label"), []]

    def handle_endtag(self, tag):
        if tag in ("style", "script"):
            self.hidden -= 1
        if tag == "label":
            self.in_label -= 1
        if tag == "title":
            self.in_title = False
        if tag == "a" and self.link:
            name = self.link[1] or re.sub(r"\s+", " ", "".join(self.link[2])).strip()
            self.links.setdefault(name, set()).add(self.link[0])
            self.link = None

    def handle_data(self, data):
        if self.hidden:
            return
        self.parts.append(data)
        if self.in_title:
            self.title += data
        if self.buttons:
            self.buttons[-1].append(data)
        if self.link:
            self.link[2].append(data)

    def text(self):
        return re.sub(r"\s+", " ", " ".join(self.parts)).strip()


def read(html):
    reader = Reader()
    reader.feed(html)
    return reader


class CopyTestCase(WorkspaceTestCase):
    def check(self, response, where):
        html = response.content.decode()
        reader = read(html)
        text = reader.text()
        self.assertNotIn("{{", html, f"{where}: unrendered placeholder")
        self.assertNotIn("{%", html, f"{where}: unrendered template tag")
        for pattern, why in BANNED:
            found = re.search(pattern, text)
            self.assertIsNone(found, f"{where}: {why}: …{text[max(0, found.start() - 60):found.end() + 60]}…" if found else "")
        self.assertTrue(reader.title.strip() and not reader.title.startswith(" ·"), f"{where}: empty page title")
        self.assertEqual(reader.h1, 1, f"{where}: needs exactly one main heading")
        unlabelled = [c for c in reader.controls if c not in reader.labelled]
        self.assertEqual(unlabelled, [], f"{where}: form controls without a label")
        for button in reader.buttons:
            self.assertTrue("".join(button).strip(), f"{where}: a button has no name")
        ambiguous = {name: sorted(hrefs) for name, hrefs in reader.links.items() if len(hrefs) > 1}
        self.assertEqual(ambiguous, {}, f"{where}: links with the same name go to different places")
        return text


class StaffPageTests(CopyTestCase):
    def pages(self):
        org = self.org
        review_ids = Review.objects.filter(organisation=org).values_list("id", flat=True)
        urls = ["/", "/customers/", "/customers/?q=nobody", "/customers/?filter=hold", "/customers/?filter=no-consent",
                "/customers/?filter=overdue", "/customers/new/", "/import/", "/collections/", "/collections/?filter=failed",
                "/collections/?filter=hold", "/collections/?q=nobody", "/payments/", "/payments/?filter=unknown",
                "/payments/?q=nobody", "/payments/new/", "/reviews/", "/reviews/?filter=mine", "/reviews/?filter=overdue",
                "/reviews/?filter=closed", "/reports/", "/settings/", "/credit/", "/cash/"]
        urls += [f"/customers/{c.id}/" for c in Customer.objects.filter(organisation=org)]
        urls += [f"/reviews/{pk}/" for pk in review_ids]
        payment = Payment.objects.filter(organisation=org).first()
        urls += [f"/refunds/{payment.id}/new/", f"/customers/{payment.instalment.loan.customer_id}/edit/"]
        return urls

    def test_every_page_for_every_role(self):
        for name in ["Ada Okafor", "Tunde Bello", "Zainab Yusuf", "Emeka Obi"]:
            self.act_as(name)
            role = self.member(name).role
            for url in self.pages():
                response = self.client.get(url)
                if response.status_code == 403:
                    self.check(response, f"{url} as {role}")
                    continue
                self.assertEqual(response.status_code, 200, f"{url} as {role}")
                text = self.check(response, f"{url} as {role}")
                for label in NAVIGATION:
                    self.assertIn(label, text, f"{url}: navigation item {label} missing")
                self.assertIn(f"Acting as {name} {role}", text)

    def test_page_titles_name_the_page(self):
        titles = {}
        for url in ["/", "/customers/", "/collections/", "/payments/", "/reviews/", "/reports/", "/settings/", "/customers/new/", "/import/", "/payments/new/"]:
            titles[url] = read(self.client.get(url).content.decode()).title
        self.assertEqual(titles["/payments/"], "Pay-by-bank · Valo Pay")
        self.assertEqual(len(set(titles.values())), len(titles), titles)
        customer = Customer.objects.filter(organisation=self.org).first()
        self.assertEqual(read(self.client.get(f"/customers/{customer.id}/").content.decode()).title, f"{customer.name} · Valo Pay")

    def test_roles_are_named_and_explained(self):
        text = self.check(self.client.get("/settings/"), "settings")
        for role in ROLES:
            self.assertIn(role, text)
            self.assertIn(content.ROLE[role], text)

    def test_states_keep_their_meaning(self):
        active = self.loan_of("Chidi Nwosu")
        self.assertIn(content.CONSENT["Active"], self.check(self.client.get(f"/customers/{active.customer_id}/"), "active consent"))
        unknown = self.loan_of("Amara Okeke")
        text = self.check(self.client.get(f"/customers/{unknown.customer_id}/"), "unknown result")
        self.assertIn("Unknown result.", text)
        self.assertNotIn("Failed", text)
        review = self.review("Unknown result")
        self.assertIn(content.REVIEW_KIND["Unknown result"], self.check(self.client.get(f"/reviews/{review.id}/"), "unknown review"))

    def test_creating_a_request_never_claims_money_moved(self):
        inst = self.loan_of("Chidi Nwosu").instalments.get(sequence=2)
        response = self.client.post("/payments/new/", {"instalment": inst.id, "amount": "100.00", "expiry_hours": 24, "confirmed": "1"}, follow=True)
        text = self.check(response, "new request")
        self.assertIn("Awaiting approval", text)
        self.assertIn(content.PAYMENT_REQUEST["Awaiting approval"], text)
        for claim in ["Payment received", "has paid", "Paid ·", "Confirmed ·"]:
            self.assertNotIn(claim, text)

    def test_approved_refund_is_not_called_refunded(self):
        payment = Payment.objects.filter(organisation=self.org).first()
        self.client.post(f"/refunds/{payment.id}/new/", {"amount": "10.00", "reason": "Paid twice"})
        item = Review.objects.get(organisation=self.org, kind="Refund request")
        self.act_as("Tunde Bello")
        response = self.client.post(f"/reviews/{item.id}/", {"action": "resolve", "outcome": "Resolved", "note": "Checked the statement"}, follow=True)
        text = self.check(response, "approved refund")
        self.assertIn("Approved Not refunded yet. No money has been returned.", text)
        self.assertIn("Nothing has been refunded yet", text)

    def test_customer_names_and_missing_details(self):
        response = self.client.post("/customers/new/", {"name": "Túndé Bakare", "external_id": "CUS-9100", "email": "", "phone": "",
                                                       "loan_id": "LN-9100", "product": "Cooperative loan", "amount": "1500.00",
                                                       "due_date": "2026-11-15", "instalment_count": 1}, follow=True)
        text = self.check(response, "new customer")
        self.assertIn("Túndé Bakare", text)
        self.assertIn("Customer added, with 1 instalment on loan LN-9100.", text)
        customer = Customer.objects.get(organisation=self.org, external_id="CUS-9100")
        rows = list(csv.reader(io.StringIO(self.client.get(f"/exports/customer/?customer={customer.id}").content.decode("utf-8-sig"))))
        self.assertEqual(rows[1][0], "LN-9100")
        self.assertIn("Túndé Bakare", self.check(self.client.get("/customers/?q=Túndé"), "search"))

    def test_form_errors_say_what_to_do(self):
        response = self.client.post("/customers/new/", {"name": "", "external_id": "", "loan_id": "", "product": "", "amount": "1,500",
                                                       "due_date": "11/15/2026", "instalment_count": 0})
        text = self.check(response, "customer form errors")
        for message in ["Enter the customer's name.", "Enter the amount as a number, for example 18450.00.",
                        "Enter the date as YYYY-MM-DD, for example 2026-11-15.", "Enter a whole number from 1 to 120."]:
            self.assertIn(message, text)
        text = self.check(self.client.post("/payments/new/", {"amount": "", "expiry_hours": "24"}), "request form errors")
        self.assertIn("Choose the instalment this payment is for.", text)

    def test_import_problems_name_the_row_and_column(self):
        response = self.import_csv(["CUS-7001,Good,,,LN-7001,Personal finance,abc,2026-11-01"])
        errors = response.context["errors"]
        self.assertTrue(all(re.match(r"Row \d+(, \w+)?: [A-Z\"]", e) for e in errors), errors)
        self.check(response, "import errors")
        missing = self.client.post("/import/", {"csv_data": "customer_id,name\nC1,A\n", "action": "commit"}, follow=True)
        problem = " ".join(missing.context["errors"])
        self.assertIn("The file is missing these columns: email, phone, loan_id, product, amount, due_date.", problem)


class BorrowerPageTests(CopyTestCase):
    def setUp(self):
        super().setUp()
        self.borrower = Client()

    def consent_token(self):
        loan = self.loan_of("Oluwaseun Adeyemi")
        self.client.post(f"/loans/{loan.id}/action/", {"action": "consent"})
        loan.refresh_from_db()
        return loan.consent_token

    def test_consent_page(self):
        token = self.consent_token()
        text = self.check(self.borrower.get(f"/consent/{token}/"), "consent page")
        self.assertIn("Valo Pay is a service provider to Meridian Finance", text)
        self.assertIn(content.RETRY_FOR_CUSTOMER["Standard"].format(lender="Meridian Finance"), text)
        # Legal wording: changes need owner approval (docs/content/copy-review.md).
        self.assertIn("I authorise Meridian Finance to debit up to ₦50,000.00 per instalment on the schedule above.", text)
        self.assertIn("You can withdraw this authorisation at any time by contacting Meridian Finance. Withdrawing does not cancel what you owe.", text)
        self.assertIn("Valo Pay never asks for your card PIN, BVN or bank password.", text)
        text = self.check(self.borrower.post(f"/consent/{token}/", {"agree": "1"}), "consent confirmation")
        self.assertIn("no direct debit authorisation was created", text)

    def test_payment_pages(self):
        inst = self.loan_of("Chidi Nwosu").instalments.get(sequence=2)
        self.client.post("/payments/new/", {"instalment": inst.id, "amount": "100.00", "expiry_hours": 24, "confirmed": "1"})
        item = PaymentRequest.objects.get(instalment=inst)
        text = self.check(self.borrower.get(f"/pay/{item.token}/"), "payment page")
        self.assertIn(f"Instalment 2 of {Instalment.objects.filter(loan=inst.loan).count()}", text)
        self.assertRegex(text, r"This link expires on \d{1,2} \w{3} \d{4} at \d\d:\d\d WAT")
        self.assertIn("no money moved", self.check(self.borrower.post(f"/pay/{item.token}/"), "payment confirmation"))
        self.client.post(f"/payments/{item.id}/cancel/")
        self.assertIn("This payment link is no longer active", self.check(self.borrower.get(f"/pay/{item.token}/"), "cancelled link"))

    def test_unknown_link(self):
        response = self.borrower.get("/consent/not-a-real-token/")
        self.assertIn(response.status_code, [200, 404])
        self.check(response, "unknown consent link")


class ErrorPageTests(CopyTestCase):
    def test_not_found(self):
        response = self.client.get("/customers/999999/")
        self.assertEqual(response.status_code, 404)
        self.assertIn("This page does not exist", self.check(response, "404"))

    def test_not_allowed(self):
        self.act_as("Emeka Obi")
        response = self.client.post("/customers/new/", {})
        self.assertEqual(response.status_code, 403)
        self.assertIn("Your current role cannot do this", self.check(response, "403"))

    def test_form_without_a_security_token(self):
        response = Client(enforce_csrf_checks=True).post("/start/")
        self.assertEqual(response.status_code, 403)
        self.assertIn("This form could not be sent", self.check(response, "CSRF"))

    def test_server_error_page_needs_no_context(self):
        html = render_to_string("500.html")
        self.assertIn("This page could not be shown", html)
        self.assertNotIn("{{", html)

    def test_start_page(self):
        response = Client().get("/")
        self.assertEqual(response.status_code, 200)
        text = self.check(response, "start page")
        self.assertIn("Open the demo workspace", text)
        self.assertIn("no money can move", text)


class ExportTests(WorkspaceTestCase):
    def rows(self, kind):
        response = self.client.get(f"/exports/{kind}/")
        self.assertEqual(response.status_code, 200, kind)
        return list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"))))

    def test_exports_have_plain_headings_and_no_empty_values(self):
        for kind in ["template", "payments", "consents", "reviews", "audit", "daily"]:
            rows = self.rows(kind)
            self.assertTrue(all(re.fullmatch(r"[a-z_]+", h) for h in rows[0]), (kind, rows[0]))
            for row in rows:
                self.assertNotIn("None", row, kind)
                self.assertNotRegex(" ".join(row).lower(), r"synthetic|sandbox", kind)

    def test_daily_summary_labels(self):
        rows = self.rows("daily")
        self.assertEqual(rows[0], ["metric", "value", "period", "data"])
        self.assertIn("Loans with active consent", [r[0] for r in rows])
        self.assertRegex(rows[3][2], r"^\d{1,2} \w{3} \d{4} to \d{1,2} \w{3} \d{4} \(WAT\)$")

    def test_review_export_names_both_people(self):
        self.assertEqual(self.rows("reviews")[0][-2:], ["prepared_by", "decided_by"])

    def test_unknown_export_is_not_found(self):
        self.assertEqual(self.client.get("/exports/nothing/").status_code, 404)
