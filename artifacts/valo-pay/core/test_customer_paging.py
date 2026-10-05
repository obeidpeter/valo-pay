from datetime import date
from django.test import TestCase
from django.utils import timezone
from .models import Customer, Loan, Instalment, Organisation, Member


class CustomerPagingTests(TestCase):
    def setUp(self):
        self.org = Organisation.objects.create(name="Isolated paging synthetic")
        actor = Member.objects.create(organisation=self.org, name="Synthetic Admin", role="Admin")
        s = self.client.session
        s.update({"org": str(self.org.pk), "actor": actor.pk, "demo_mode": True})
        s.save()
        self.customer = Customer.objects.create(organisation=self.org, name="Synthetic dense", external_id="DENSE")
        self.loan = Loan.objects.create(organisation=self.org, customer=self.customer, reference="DENSE-LOAN")
        Instalment.objects.bulk_create([
            Instalment(organisation=self.org, loan=self.loan, sequence=i, amount=123456789,
                       due_date=date(2027, 1, 1)) for i in range(1, 5001)
        ])

    def test_dense_schedule_bounded_and_all_pages_accessible(self):
        response = self.client.get(f"/customers/{self.customer.pk}/")
        loans = response.context["loans"]
        schedule = loans[0].schedule_page
        self.assertEqual(schedule.paginator.count, 5000)
        self.assertEqual(len(schedule), 20)
        self.assertEqual(schedule.paginator.num_pages, 250)
        self.assertLess(len(response.content), 100000)
        self.assertContains(response, "of 5000 matching instalments")
        last = self.client.get(f"/customers/{self.customer.pk}/?schedule_{self.loan.pk}=250&payments_page=2")
        self.assertEqual(last.context["loans"][0].schedule_page[-1].sequence, 5000)
        self.assertContains(last, "payments_page=2")
        self.assertContains(last, "1,234,567.89")
        csv = self.client.get(f"/exports/schedule/?customer={self.customer.pk}")
        self.assertEqual(len(csv.content.decode("utf-8-sig").splitlines()), 5001)

    def test_loan_pagination_and_tenant_boundary(self):
        Loan.objects.bulk_create([Loan(organisation=self.org, customer=self.customer, reference=f"EXTRA-{i}") for i in range(8)])
        response = self.client.get(f"/customers/{self.customer.pk}/?loans_page=2")
        self.assertEqual(response.context["loans"].paginator.count, 9)
        self.assertEqual(len(response.context["loans"]), 4)
        foreign_org = Organisation.objects.create(name="Other synthetic")
        foreign = Customer.objects.create(organisation=foreign_org, name="Private synthetic", external_id="OTHER")
        self.assertEqual(self.client.get(f"/customers/{foreign.pk}/?loans_page=2").status_code, 404)

    def test_borrower_dense_schedule_is_bounded_without_losing_records(self):
        self.loan.consent_token = "isolated-synthetic-consent-fixture"
        self.loan.consent_status = "Requested"
        self.loan.consent_requested_at = timezone.now()
        self.loan.consent_expiry = date(2030, 1, 1)
        self.loan.save()
        route = f"/consent/{self.loan.consent_token}/"
        response = self.client.get(route)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.context["instalments"]), 20)
        self.assertContains(response, "of 5000 matching instalments")
        self.assertLess(len(response.content), 15000)
        last = self.client.get(route + "?page=250")
        self.assertEqual(last.context["instalments"][-1].sequence, 5000)