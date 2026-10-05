"""The demo's stand-in for the morning direct-debit run, and the plain review names on the Dashboard."""
from datetime import timedelta

from django.utils import timezone

from core.models import Audit, Instalment, Payment, PaymentRequest
from .test_copy import CopyTestCase, read


class DebitRunTests(CopyTestCase):
    def due_today(self, name):
        return Instalment.objects.select_related("loan").get(organisation=self.org, loan__customer__name=name, due_date=timezone.localdate())

    def run_debits(self, **kwargs):
        return self.client.post("/debits/run/", **kwargs)

    def debited(self, *names):
        return Payment.objects.filter(instalment__loan__customer__name__in=names, source="Direct debit", paid_at__date=timezone.localdate()).count()

    def test_the_dashboard_shows_what_the_run_will_do(self):
        text = self.check(self.client.get("/"), "dashboard before the run")
        self.assertIn("Run today's debits", text)
        self.assertEqual(text.count("Ready for today's run"), 3)
        self.assertIn("Not debited: the customer's bank has not activated the consent yet", text)

    def test_the_run_collects_fails_and_skips_by_the_rules(self):
        response = self.run_debits(follow=True)
        self.assertEqual(response.request["PATH_INFO"], "/")
        self.assertIn("Today's direct debits ran on sample data: 2 collected, 1 failed and 1 not debited. No bank was contacted and no money moved.",
                      " ".join(self.messages_in(response)))
        for name in ["Chidi Nwosu", "Tobechukwu Eze"]:
            inst = self.due_today(name)
            self.assertEqual((inst.state, inst.paid), ("Paid", inst.amount), name)
            self.assertEqual(self.debited(name), 1, name)
        self.assertTrue(all(ref.startswith("DEMO-DD-") for ref in Payment.objects.filter(instalment__due_date=timezone.localdate(), source="Direct debit").values_list("reference", flat=True)))
        self.assertEqual((self.due_today("Nneka Umeh").state, self.due_today("Nneka Umeh").paid), ("Failed", 0))
        self.assertEqual((self.due_today("Fatima Ibrahim").state, self.due_today("Fatima Ibrahim").paid), ("Upcoming", 0))
        self.assertEqual(self.debited("Nneka Umeh", "Fatima Ibrahim"), 0)
        self.assertFalse(PaymentRequest.objects.filter(organisation=self.org).exists())
        text = self.check(response, "dashboard after the run")
        retry = timezone.localdate() + timedelta(days=2)
        for words in ["Collected by direct debit", f"Debit failed · next try on {retry.day} {retry:%b %Y}",
                      "Today's debits have run: 2 collected, 1 failed and 1 not debited. No bank was contacted."]:
            self.assertIn(words, text)
        self.assertNotIn("Ready for today's run", text)
        self.assertEqual(list(Audit.objects.filter(organisation=self.org).values_list("action", flat=True)[:4]),
                         ["Today's direct debits run", "Direct debit failed", "Direct debit confirmed", "Direct debit confirmed"])

    def test_running_again_debits_nothing_twice(self):
        self.run_debits()
        payments = Payment.objects.filter(organisation=self.org).count()
        response = self.run_debits(follow=True)
        self.assertEqual(Payment.objects.filter(organisation=self.org).count(), payments)
        self.assertEqual(self.due_today("Nneka Umeh").state, "Failed")
        self.assertIn("Nothing new to debit today.", " ".join(self.messages_in(response)))

    def test_holds_requests_and_the_maximum_are_respected(self):
        chidi = self.due_today("Chidi Nwosu")
        chidi.loan.on_hold = True
        chidi.loan.save()
        self.client.post("/payments/new/", {"instalment": self.due_today("Tobechukwu Eze").id, "amount": "100.00", "expiry_hours": 24, "confirmed": "1"})
        nneka = self.due_today("Nneka Umeh").loan
        nneka.consent_max = 100
        nneka.save()
        text = self.check(self.client.get("/"), "dashboard with a hold, a request and a low maximum")
        for words in ["Not debited: the loan is on hold", "Not debited: a payment request for it is in progress",
                      "Not debited: it is more than the customer's maximum per debit"]:
            self.assertIn(words, text)
        self.assertNotIn("Run today's debits", text)
        self.run_debits()
        self.assertEqual(self.debited("Chidi Nwosu", "Tobechukwu Eze", "Nneka Umeh", "Fatima Ibrahim"), 0)

    def test_the_retry_rule_sets_the_next_try(self):
        self.org.retry_preset = "Off"
        self.org.save()
        self.run_debits()
        self.assertIn("Debit failed · no automatic retry: the retry rule is Off", read(self.client.get("/").content.decode()).text())

    def test_only_admins_and_preparers_can_run_it(self):
        for name in ["Tunde Bello", "Emeka Obi"]:
            self.act_as(name)
            self.assertEqual(self.run_debits().status_code, 403, name)
            text = self.check(self.client.get("/"), f"dashboard as {name}")
            self.assertIn("An Admin or Preparer can run today's debits.", text)
        self.assertEqual(self.debited("Chidi Nwosu"), 0)
        self.act_as("Zainab Yusuf")
        self.assertRedirects(self.run_debits(), "/#due-today", fetch_redirect_response=False)
        self.assertEqual(self.client.get("/debits/run/").status_code, 405)


class PlainReviewNameTests(CopyTestCase):
    def test_unknown_results_read_plainly_but_keep_their_name_in_data(self):
        text = self.check(self.client.get("/"), "dashboard")
        self.assertIn("Payment result not known · Amara Okeke We do not know yet if this payment went through.", text)
        self.assertNotIn("Unknown result", text)
        found = self.check(self.client.get("/reviews/", {"q": "result not known"}), "review search by the plain name")
        self.assertIn("Amara Okeke", found)
        self.assertIn("Payment result not known · Review", read(self.client.get(f"/reviews/{self.review('Unknown result').id}/").content.decode()).title)
        self.assertIn("Unknown result", self.client.get("/exports/reviews/").content.decode())
