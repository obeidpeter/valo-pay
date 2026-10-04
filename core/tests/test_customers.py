from core.models import Customer, Instalment, Loan, PaymentRequest, Audit, Review
from .base import WorkspaceTestCase

TWO_LOANS = ["CUS-9001,Test Person,t@example.com,,LN-9001,Personal finance,1000.50,2026-11-01",
             "CUS-9001,Test Person,t@example.com,,LN-9001,Personal finance,1000.50,2026-12-01",
             "CUS-9001,Test Person,t@example.com,,LN-9002,Asset finance,2500.00,2026-11-15"]


class MultiLoanTests(WorkspaceTestCase):
    def setUp(self):
        super().setUp()
        self.import_csv(TWO_LOANS)
        self.customer = Customer.objects.get(organisation=self.org, external_id="CUS-9001")
        self.first, self.second = self.customer.loans.order_by("id")

    def test_customer_page_shows_every_loan(self):
        response = self.client.get(f"/customers/{self.customer.id}/")
        self.assertEqual([l.reference for l in response.context["loans"]], ["LN-9001", "LN-9002"])
        for loan in (self.first, self.second):
            self.assertContains(response, f'action="/loans/{loan.id}/action/"')
            for inst in loan.instalments.all():
                self.assertContains(response, f"/payments/new/?instalment={inst.id}")

    def test_customer_list_shows_loans_with_consent_and_hold(self):
        response = self.client.get("/customers/")
        self.assertContains(response, "LN-9001")
        self.assertContains(response, "LN-9002")
        self.assertContains(response, '<span class="mono">LN-2041</span> <span class="badge b-active">Active</span> <span class="badge b-hold">On hold</span>')

    def test_edit_targets_the_chosen_loan(self):
        url = f"/customers/{self.customer.id}/edit/?loan={self.second.id}"
        self.assertEqual(self.client.get(url).context["form"]["loan_id"].value(), "LN-9002")
        self.client.post(url, {"name": "Test Person", "external_id": "CUS-9001", "email": "t@example.com", "phone": "", "product": "Equipment lease"})
        self.first.refresh_from_db(); self.second.refresh_from_db()
        self.assertEqual((self.first.product, self.second.product), ("Personal finance", "Equipment lease"))

    def test_edit_rejects_other_customers_loans_and_bad_ids(self):
        other = self.loan_of("Chidi Nwosu")
        for value in [str(other.id), "abc", "²"]:
            self.assertEqual(self.client.get(f"/customers/{self.customer.id}/edit/?loan={value}").status_code, 404, value)


class LoanPageTests(WorkspaceTestCase):
    def test_audit_trail_matches_loan_reference_exactly(self):
        self.import_csv(["CUS-8001,One,,,LN-1,Personal finance,100.00,2026-11-01",
                         "CUS-8002,Ten,,,LN-10,Personal finance,100.00,2026-11-01"])
        for ref, reason in [("LN-1", "mine"), ("LN-10", "theirs")]:
            loan = Loan.objects.get(organisation=self.org, reference=ref)
            self.client.post(f"/loans/{loan.id}/action/", {"action": "hold", "reason": reason})
        customer = Customer.objects.get(organisation=self.org, external_id="CUS-8001")
        details = [a.detail for a in self.client.get(f"/customers/{customer.id}/").context["activity"]]
        self.assertEqual(details, ["LN-1: mine"])

    def test_consent_link_shown_only_while_usable(self):
        amara = self.loan_of("Amara Okeke")
        self.assertNotContains(self.client.get(f"/customers/{amara.customer_id}/"), "/consent/")
        loan = self.loan_of("Oluwaseun Adeyemi")
        self.client.post(f"/loans/{loan.id}/action/", {"action": "consent"})
        loan.refresh_from_db()
        self.assertContains(self.client.get(f"/customers/{loan.customer_id}/"), f"/consent/{loan.consent_token}/")

    def test_request_button_only_for_payable_instalments(self):
        loan = self.loan_of("Chidi Nwosu")
        paid, due = loan.instalments.order_by("sequence")[:2]
        for url in [f"/customers/{loan.customer_id}/", "/collections/"]:
            response = self.client.get(url)
            self.assertNotContains(response, f"/payments/new/?instalment={paid.id}\"")
            self.assertContains(response, f"/payments/new/?instalment={due.id}\"")
        held = self.loan_of("Amara Okeke")
        self.assertNotContains(self.client.get(f"/customers/{held.customer_id}/"), "/payments/new/?instalment=")


class CloseLoanTests(WorkspaceTestCase):
    def close(self, loan):
        return self.client.post(f"/loans/{loan.id}/action/", {"action": "close", "reason": "test"}, follow=True)

    def test_unknown_result_blocks_closing(self):
        loan = self.loan_of("Amara Okeke")
        response = self.close(loan)
        loan.refresh_from_db()
        self.assertEqual(loan.status, "Open")
        self.assertIn("Unknown result", " ".join(self.messages_in(response)))

    def test_in_progress_instalment_blocks_closing(self):
        loan = self.loan_of("Chidi Nwosu")
        Instalment.objects.filter(loan=loan, sequence=2).update(state="In progress")
        self.close(loan)
        loan.refresh_from_db()
        self.assertEqual(loan.status, "Open")

    def test_closing_cancels_pending_requests_once(self):
        loan = self.loan_of("Chidi Nwosu")
        inst = loan.instalments.get(sequence=2)
        self.client.post("/payments/new/", {"instalment": inst.id, "amount": "100.00", "expiry_hours": 24, "confirmed": "1"})
        self.close(loan)
        loan.refresh_from_db()
        self.assertEqual(loan.status, "Closed")
        self.assertEqual(PaymentRequest.objects.get(instalment=inst).status, "Cancelled")
        self.assertIn("already closed", " ".join(self.messages_in(self.close(loan))))
        self.assertEqual(Audit.objects.filter(organisation=self.org, action="Loan closed").count(), 1)


class ConsentAndHoldTests(WorkspaceTestCase):
    def act(self, loan, action, reason="test"):
        return self.client.post(f"/loans/{loan.id}/action/", {"action": action, "reason": reason}, follow=True)

    def test_withdraw_needs_an_unused_link(self):
        loan = self.loan_of("Oluwaseun Adeyemi")
        self.assertIn("no unused consent link", " ".join(self.messages_in(self.act(loan, "withdraw"))))
        loan.refresh_from_db()
        self.assertEqual(loan.consent_status, "Not requested")
        self.act(loan, "consent")
        self.act(loan, "withdraw")
        loan.refresh_from_db()
        self.assertEqual(loan.consent_status, "Withdrawn")

    def test_active_consent_withdrawal_is_not_claimed(self):
        loan = self.loan_of("Chidi Nwosu")
        said = " ".join(self.messages_in(self.act(loan, "withdraw")))
        self.assertIn("Consent cannot be withdrawn in this demo", said)
        self.assertIn("The consent is unchanged", said)
        loan.refresh_from_db()
        self.assertEqual(loan.consent_status, "Active")

    def test_hold_release_needs_a_different_person(self):
        loan = self.loan_of("Chidi Nwosu")
        self.act_as("Tunde Bello")
        self.act(loan, "hold")
        self.assertIn("a different person must release it", " ".join(self.messages_in(self.act(loan, "release"))))
        self.act_as("Zainab Yusuf")
        self.assertEqual(self.client.post(f"/loans/{loan.id}/action/", {"action": "release", "reason": "x"}).status_code, 403)
        self.act_as("Ada Okafor")
        self.act(loan, "release")
        loan.refresh_from_db()
        self.assertFalse(loan.on_hold)

    def test_unknown_result_hold_cannot_be_released(self):
        loan = self.loan_of("Amara Okeke")
        self.act_as("Tunde Bello")
        self.act(loan, "release")
        loan.refresh_from_db()
        self.assertTrue(loan.on_hold)


class MalformedIdTests(WorkspaceTestCase):
    def test_bad_ids_are_not_found_not_server_errors(self):
        customer = Customer.objects.filter(organisation=self.org).first()
        review = Review.objects.filter(organisation=self.org).first()
        self.assertEqual(self.client.get(f"/exports/customer/?customer={customer.id}").status_code, 200)
        for value in ["abc", "²", "", "99999999999999999999"]:
            self.assertEqual(self.client.get(f"/exports/customer/?customer={value}").status_code, 404, value)
        for value in ["abc", "²"]:
            self.assertEqual(self.client.get(f"/payments/new/?instalment={value}").status_code, 404, value)
            self.assertEqual(self.client.post("/demo-role/", {"member": value}).status_code, 404, value)
            self.assertEqual(self.client.post(f"/reviews/{review.id}/", {"action": "assign", "owner": value}).status_code, 404, value)
