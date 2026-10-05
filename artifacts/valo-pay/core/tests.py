from django.test import Client, TestCase, override_settings
from django.urls import reverse
from django.contrib.auth import get_user_model
from django_otp.plugins.otp_totp.models import TOTPDevice
from .services import seed_demo
from .models import Loan, Audit


@override_settings(ALLOWED_HOSTS=["valo-preview.picard.replit.dev", "testserver"])
class ExternalPreviewCsrfTests(TestCase):
    def setUp(self):
        self.client = Client(enforce_csrf_checks=True)
        self.origin = "https://valo-preview.picard.replit.dev"
        self.data = {"name": "Synthetic QA", "email": "qa-flow@example.invalid",
                     "organisation": "Synthetic Co", "organisation_type": "lender"}

    def load_form(self):
        response = self.client.get("/request-demo/", secure=True,
                                   HTTP_HOST="valo-preview.picard.replit.dev")
        self.assertEqual(response["Referrer-Policy"], "same-origin")
        self.assertEqual(response["Cache-Control"], "no-store")
        self.assertTrue(self.client.cookies["csrftoken"]["secure"])
        return self.client.cookies["csrftoken"].value

    def post(self, origin, token):
        return self.client.post("/request-demo/", {**self.data, "csrfmiddlewaretoken": token},
                                HTTP_HOST="valo-preview.picard.replit.dev",
                                HTTP_X_FORWARDED_PROTO="https", HTTP_ORIGIN=origin)

    def test_two_fresh_loads_accept_same_origin_through_https_proxy(self):
        from .models import DemoLead
        for _ in range(2):
            token = self.load_form()
            response = self.post(self.origin, token)
            self.assertContains(response, "Nothing was saved or sent")
            self.assertNotContains(response, "We review your request.")
            self.assertNotContains(response, "We use them only to arrange a conversation")
        self.assertEqual(DemoLead.objects.count(), 0)

    def test_missing_and_invalid_tokens_are_rejected(self):
        self.load_form()
        for token in ("", "a" * 32):
            self.assertEqual(self.post(self.origin, token).status_code, 403)

    def test_foreign_sibling_and_null_origins_are_rejected(self):
        token = self.load_form()
        for origin in ("https://foreign.example", "https://other.picard.replit.dev", "null"):
            self.assertEqual(self.post(origin, token).status_code, 403)


class SafetyRegressionTests(TestCase):
    def test_paid_on_hold_keeps_paid_label(self):
        from .models import Instalment
        i = Instalment.objects.filter(organisation=self.org, state="Paid").first()
        i.loan.on_hold = True
        i.loan.save()
        self.assertEqual(i.status, "Paid")

    def test_conflicting_csv_metadata_rejected(self):
        from .services import validate_csv
        text = "customer_id,name,email,phone,loan_id,product,amount,due_date\nX,Test,a@example.invalid,,Z,Test,1.00,2027-01-01\nX,Test,b@example.invalid,,Z,Other,1.00,2027-02-01"
        errors, _ = validate_csv(text, self.org)
        self.assertTrue(errors)
        self.assertIn("conflicting", errors[0])

    def test_revoked_demo_role_does_not_become_admin(self):
        session = self.client.session
        session["actor"] = -1
        session.save()
        self.assertEqual(self.client.get("/today/").status_code, 403)

    def setUp(self):
        self.org, self.actor = seed_demo()
        session = self.client.session
        session["org"] = str(self.org.pk)
        session["actor"] = self.actor.pk
        session.save()

    def test_unknown_cannot_close(self):
        loan = Loan.objects.get(organisation=self.org, instalments__state="Unknown")
        self.client.post(reverse("loan_action", args=[loan.pk]), {"action": "close", "reason": "Synthetic test"})
        loan.refresh_from_db()
        self.assertEqual(loan.status, "Open")

    def test_cannot_release_unknown(self):
        loan = Loan.objects.get(organisation=self.org, instalments__state="Unknown")
        self.client.post(reverse("loan_action", args=[loan.pk]), {"action": "release", "reason": "Synthetic test"})
        loan.refresh_from_db()
        self.assertTrue(loan.on_hold)

    def test_tenant_isolation(self):
        other, _ = seed_demo()
        customer = Loan.objects.filter(organisation=other).first().customer
        self.assertEqual(self.client.get(reverse("customer_detail", args=[customer.pk])).status_code, 404)

    def test_real_identity_cannot_use_demo_roles(self):
        user = get_user_model().objects.create_user("synthetic@example.invalid", password="Synthetic-test-only-passphrase")
        self.client.force_login(user)
        self.assertEqual(self.client.get("/today/").status_code, 302)

    def test_first_factor_does_not_grant_staff_access(self):
        get_user_model().objects.create_user("synthetic@example.invalid", password="Synthetic-test-only-passphrase")
        r = self.client.post("/access/login/", {"email": "synthetic@example.invalid", "password": "Synthetic-test-only-passphrase"})
        self.assertRedirects(r, "/access/challenge/", fetch_redirect_response=False)
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_no_device_cannot_complete_two_step(self):
        user = get_user_model().objects.create_user("synthetic@example.invalid", password="Synthetic-test-only-passphrase")
        self.client.post("/access/login/", {"email": user.username, "password": "Synthetic-test-only-passphrase"})
        self.client.post("/access/challenge/", {"code": "123456"})
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_public_collection_fails_closed(self):
        r = self.client.post("/request-demo/", {"name": "Synthetic", "email": "synthetic@example.invalid", "organisation": "Test", "organisation_type": "lender"})
        self.assertContains(r, "Nothing was saved or sent")

    def test_private_pages_no_index_or_cache(self):
        r = self.client.get("/today/")
        self.assertEqual(r["Cache-Control"], "no-store")
        self.assertIn("noindex", r["X-Robots-Tag"])

    def test_borrower_invalid_token_does_not_confirm(self):
        r = self.client.get("/pay/not-a-real-token/")
        self.assertEqual(r.status_code, 404)

    def test_preview_routes_exist(self):
        for route in ("/credit/", "/cash/"):
            self.assertEqual(self.client.get(route).status_code, 200)

    @override_settings(SYNTHETIC_LEAD_TEST=True)
    def test_synthetic_acceptance_is_durable_and_deduplicated(self):
        from .models import DemoLead
        data = {"name": "Synthetic", "email": "synthetic@example.invalid", "organisation": "Synthetic Co", "organisation_type": "lender"}
        for _ in range(2):
            self.assertEqual(self.client.post("/request-demo/", data).status_code, 200)
        self.assertEqual(DemoLead.objects.count(), 1)

    def test_duplicate_request_not_created(self):
        from .models import Instalment, PaymentRequest
        i = Instalment.objects.filter(organisation=self.org, paid=0, state="Upcoming", loan__on_hold=False).first()
        data = {"instalment": i.pk, "amount": str(i.amount // 100), "expiry_hours": 24, "confirmed": "1"}
        for _ in range(2):
            self.client.post("/payments/new/", data)
        self.assertEqual(PaymentRequest.objects.filter(instalment=i).count(), 1)

    def test_admin_cannot_approve_own_refund(self):
        from .models import Payment, Review, Refund
        p = Payment.objects.filter(organisation=self.org).first()
        self.client.post(reverse("refund_new", args=[p.pk]), {"amount": "1.00", "reason": "Synthetic"})
        r = Review.objects.get(organisation=self.org, kind="Refund request")
        self.client.post(reverse("review_detail", args=[r.pk]), {"action": "resolve", "outcome": "Resolved", "note": "Synthetic"})
        self.assertEqual(Refund.objects.get(review=r).status, "Requested")