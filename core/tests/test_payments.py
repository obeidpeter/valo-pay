import hashlib
from datetime import date, datetime
from unittest import mock
from zoneinfo import ZoneInfo
from django.test import TestCase
from core.models import Organisation, Customer, Loan, Instalment, Payment, PaymentRequest, Audit
from core.views import metrics
from .base import WorkspaceTestCase

LAGOS, UTC = ZoneInfo("Africa/Lagos"), ZoneInfo("UTC")


class PaymentRequestTests(WorkspaceTestCase):
    def setUp(self):
        super().setUp()
        self.inst = self.loan_of("Chidi Nwosu").instalments.get(sequence=2)

    def request(self, amount="100.00"):
        return self.client.post("/payments/new/", {"instalment": self.inst.id, "amount": amount, "expiry_hours": 24, "confirmed": "1"})

    def test_one_active_request_per_instalment(self):
        self.request()
        self.request()
        self.assertEqual(PaymentRequest.objects.filter(instalment=self.inst).count(), 1)

    def test_amount_cannot_exceed_outstanding(self):
        self.request(f"{(self.inst.amount + 1) / 100:.2f}")
        self.assertFalse(PaymentRequest.objects.filter(instalment=self.inst).exists())


class BorrowerPageTests(WorkspaceTestCase):
    def setUp(self):
        super().setUp()
        inst = self.loan_of("Chidi Nwosu").instalments.get(sequence=2)
        self.client.post("/payments/new/", {"instalment": inst.id, "amount": "100.00", "expiry_hours": 24, "confirmed": "1"})
        self.item = PaymentRequest.objects.get(instalment=inst)
        self.borrower = self.client_class()

    def test_payment_hand_off_is_truthful(self):
        self.assertEqual(self.borrower.get(f"/pay/{self.item.token}/").context["kind"], "payment")
        response = self.borrower.post(f"/pay/{self.item.token}/")
        self.assertEqual(response.context["kind"], "confirmation")
        self.assertContains(response, "<b>no money moved</b>")
        self.assertNotContains(response, "Payment received")

    def test_consent_hand_off_is_truthful(self):
        loan = self.loan_of("Oluwaseun Adeyemi")
        self.client.post(f"/loans/{loan.id}/action/", {"action": "consent"})
        loan.refresh_from_db()
        self.assertEqual(self.borrower.get(f"/consent/{loan.consent_token}/").context["kind"], "consent")
        self.assertEqual(self.borrower.post(f"/consent/{loan.consent_token}/", {"agree": "1"}).context["kind"], "confirmation")

    def test_cancelled_link_stays_expired(self):
        self.client.post(f"/payments/{self.item.id}/cancel/")
        self.assertEqual(self.borrower.post(f"/pay/{self.item.token}/").context["kind"], "expired")

    def test_borrower_pages_never_create_workspaces(self):
        count = Organisation.objects.count()
        self.borrower.get(f"/pay/{self.item.token}/")
        self.borrower.post(f"/pay/{self.item.token}/")
        self.assertEqual(Organisation.objects.count(), count)


class MonthBoundaryTests(TestCase):
    def test_collected_this_month_starts_at_midnight_in_lagos(self):
        org = Organisation.objects.create()
        loan = Loan.objects.create(organisation=org, customer=Customer.objects.create(organisation=org, name="A", external_id="C1"), reference="L1")
        inst = Instalment.objects.create(organisation=org, loan=loan, sequence=1, due_date=date(2026, 10, 1), amount=500000)
        for ref, paid_at in [("SEPT", datetime(2026, 9, 30, 23, 30)), ("OCT", datetime(2026, 10, 1, 0, 15))]:
            Payment.objects.create(organisation=org, instalment=inst, reference=ref, amount=10000, paid_at=paid_at.replace(tzinfo=LAGOS))
        # timezone.now() returns UTC: 23:45 on 30 September UTC is 00:45 on 1 October in Lagos.
        with mock.patch("django.utils.timezone.now", return_value=datetime(2026, 9, 30, 23, 45, tzinfo=UTC)):
            result = metrics(org)
        self.assertEqual((result["confirmed_count"], result["collected_display"]), (1, "₦100.00"))


class RecordTests(WorkspaceTestCase):
    def test_import_is_all_or_nothing(self):
        response = self.import_csv(["CUS-7001,Good,,,LN-7001,Personal finance,100.00,2026-11-01",
                                    "CUS-7002,Bad,,,LN-7002,Personal finance,100.005,2026-11-01"])
        self.assertIn("Row 3, amount:", " ".join(response.context["errors"]))
        self.assertFalse(Customer.objects.filter(organisation=self.org, external_id__in=["CUS-7001", "CUS-7002"]).exists())

    def test_duplicate_loan_ids_are_rejected(self):
        response = self.import_csv(["CUS-7001,Dup,,,LN-2041,Personal finance,100.00,2026-11-01"])
        self.assertIn("Row 2, loan_id: LN-2041 is already used", " ".join(response.context["errors"]))

    def test_audit_hash_chain_verifies(self):
        self.client.post(f"/loans/{self.loan_of('Chidi Nwosu').id}/action/", {"action": "hold", "reason": "check"})
        previous = ""
        for entry in Audit.objects.filter(organisation=self.org).order_by("id"):
            self.assertEqual(entry.previous_hash, previous)
            self.assertEqual(entry.digest, hashlib.sha256(f"{previous}|{entry.actor_name}|{entry.action}|{entry.detail}".encode()).hexdigest())
            previous = entry.digest

    def test_only_admins_download_the_audit_extract(self):
        self.assertEqual(self.client.get("/exports/audit/").status_code, 200)
        self.act_as("Emeka Obi")
        self.assertEqual(self.client.get("/exports/audit/").status_code, 403)
        self.assertEqual(self.client.get("/exports/payments/").status_code, 200)
