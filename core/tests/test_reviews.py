from datetime import timedelta
from django.utils import timezone
from core.models import Payment, Refund, Review
from .base import WorkspaceTestCase


class ReviewQueueTests(WorkspaceTestCase):
    def ids(self, url):
        return [r.id for r in self.client.get(url).context["reviews"]]

    def resolve(self, review, outcome="Resolved"):
        return self.client.post(f"/reviews/{review.id}/", {"action": "resolve", "outcome": outcome, "note": "checked"}, follow=True)

    def test_queue_lists_only_open_items(self):
        item = self.review("Consent problem")
        self.act_as("Tunde Bello")
        self.resolve(item)
        self.assertNotIn(item.id, self.ids("/reviews/"))
        self.assertEqual(len(self.ids("/reviews/")), 3)
        self.assertEqual(self.ids("/reviews/?filter=closed"), [item.id])

    def test_mine_and_overdue_hold_only_open_items(self):
        item = self.review("Consent problem")
        Review.objects.filter(pk=item.pk).update(deadline=timezone.now() - timedelta(days=1))
        self.act_as("Tunde Bello")
        for url in ["/reviews/?filter=mine", "/reviews/?filter=overdue"]:
            self.assertIn(item.id, self.ids(url))
        self.resolve(item)
        for url in ["/reviews/?filter=mine", "/reviews/?filter=overdue"]:
            self.assertNotIn(item.id, self.ids(url))

    def test_viewers_cannot_own_reviews(self):
        item = self.review("Consent problem")
        self.assertNotIn("Viewer", [m.role for m in self.client.get(f"/reviews/{item.id}/").context["owners"]])
        response = self.client.post(f"/reviews/{item.id}/", {"action": "assign", "owner": self.member("Emeka Obi").id}, follow=True)
        item.refresh_from_db()
        self.assertEqual(item.owner.name, "Tunde Bello")
        self.assertIn("read-only", " ".join(self.messages_in(response)))

    def test_preparer_can_resolve_items_that_cannot_move_money(self):
        self.act_as("Zainab Yusuf")
        item = self.review("Non-retryable failure")
        self.assertTrue(self.client.get(f"/reviews/{item.id}/").context["can_decide"])
        self.resolve(item)
        item.refresh_from_db()
        self.assertEqual((item.status, item.resolved_by.name), ("Resolved", "Zainab Yusuf"))

    def test_items_needing_provider_evidence_stay_blocked(self):
        self.act_as("Tunde Bello")
        item = self.review("Unknown result")
        self.assertNotContains(self.client.get(f"/reviews/{item.id}/"), 'name="outcome"')
        self.resolve(item)
        item.refresh_from_db()
        self.assertEqual(item.status, "Open")


class RefundDecisionTests(WorkspaceTestCase):
    def setUp(self):
        super().setUp()
        self.payment = Payment.objects.filter(organisation=self.org).first()
        self.client.post(f"/refunds/{self.payment.id}/new/", {"amount": "10.00", "reason": "Customer overpaid"})
        self.item = self.review("Refund request")

    def decide(self, outcome="Resolved"):
        return self.client.post(f"/reviews/{self.item.id}/", {"action": "resolve", "outcome": outcome, "note": "checked"}, follow=True)

    def refund_status(self):
        return Refund.objects.get(review=self.item).status

    def test_requester_cannot_approve_own_refund(self):
        self.assertFalse(self.client.get(f"/reviews/{self.item.id}/").context["can_decide"])
        self.decide()
        self.assertEqual(self.refund_status(), "Requested")

    def test_preparer_role_cannot_decide_money_items(self):
        self.act_as("Zainab Yusuf")
        self.assertNotContains(self.client.get(f"/reviews/{self.item.id}/"), 'name="outcome"')
        self.assertEqual(self.client.post(f"/reviews/{self.item.id}/", {"action": "resolve", "outcome": "Resolved", "note": "x"}).status_code, 403)

    def test_reviewer_approves_or_rejects(self):
        self.act_as("Tunde Bello")
        self.assertContains(self.client.get(f"/reviews/{self.item.id}/"), "Approve refund")
        self.decide("Dismissed")
        self.assertEqual(self.refund_status(), "Rejected")

    def test_handcrafted_outcomes_are_refused(self):
        self.act_as("Tunde Bello")
        self.decide("Failed")
        self.item.refresh_from_db()
        self.assertEqual((self.item.status, self.refund_status()), ("Open", "Requested"))

    def test_closed_reviews_cannot_be_reassigned(self):
        self.act_as("Tunde Bello")
        self.decide()
        self.assertEqual(self.refund_status(), "Approved")
        response = self.client.post(f"/reviews/{self.item.id}/", {"action": "assign", "owner": self.member("Zainab Yusuf").id}, follow=True)
        self.item.refresh_from_db()
        self.assertEqual(self.item.owner.name, "Tunde Bello")
        self.assertIn("already closed", " ".join(self.messages_in(response)))

    def test_refunds_cannot_exceed_what_is_left(self):
        left = self.payment.amount - 1000
        self.client.post(f"/refunds/{self.payment.id}/new/", {"amount": f"{(left + 1) / 100:.2f}", "reason": "Too much"})
        self.assertEqual(Refund.objects.filter(payment=self.payment).count(), 1)
