"""Explicit hypothetical calendars, not an assertion about Nigerian public holidays."""
from datetime import datetime, timezone as utc
import time
from django.contrib.auth import get_user_model
from django.test import TestCase, SimpleTestCase, override_settings, Client
from .business_days import review_deadline, CalendarUnavailable, approval_deadline_error
from .models import Payment, Review, Refund, StaffMembership, Audit
from .services import seed_demo
from .access_services import issue

APPROVED_TEST_CALENDAR = {
    "reference": "TEST ONLY hypothetical approved calendar",
    "approved": True, "complete": True,
    "coverage_start": "2020-01-01", "coverage_end": "2100-12-31", "holidays": [],
}


@override_settings(REVIEW_BUSINESS_CALENDAR=APPROVED_TEST_CALENDAR)
class CalendarCalculationTests(SimpleTestCase):
    def at(self, value):
        return datetime.fromisoformat(value).replace(tzinfo=utc.utc)

    def test_friday_weekend_and_targets(self):
        for kind, expected in (("Unknown result","2026-10-05"),("Refund request","2026-10-06"),
                               ("Unclear match","2026-10-07"),("Refund after withdrawal","2026-10-09")):
            with self.subTest(kind=kind):
                result,basis=review_deadline(kind,self.at("2026-10-02T15:20:00"))
                self.assertEqual(str(result.date()),expected)
                self.assertEqual((result.hour,result.minute),(16,20))
                self.assertEqual(basis["status"],"approved")
        for day in ("2026-10-03","2026-10-04"):
            result,_=review_deadline("Unknown result",self.at(day+"T12:00:00"))
            self.assertEqual(str(result.date()),"2026-10-05")

    def test_configured_holiday_and_month_year_boundary(self):
        with override_settings(REVIEW_BUSINESS_CALENDAR={**APPROVED_TEST_CALENDAR,"holidays":["2026-10-05","2027-01-01"]}):
            result,_=review_deadline("Refund request",self.at("2026-10-02T15:20:00"))
            self.assertEqual(str(result.date()),"2026-10-07")
            result,_=review_deadline("Unknown result",self.at("2026-12-31T12:00:00"))
            self.assertEqual(str(result.date()),"2027-01-04")
        result,_=review_deadline("Unknown result",self.at("2026-10-30T12:00:00"))
        self.assertEqual(str(result.date()),"2026-11-02")

    def test_wat_opening_day_not_utc_day(self):
        result,_=review_deadline("Unknown result",self.at("2026-10-04T23:30:00"))
        self.assertEqual(str(result.date()),"2026-10-06")
        self.assertEqual((result.hour,result.minute),(0,30))

    def test_missing_incomplete_unapproved_and_cross_coverage_fail_closed(self):
        calendars=[None,{}, {**APPROVED_TEST_CALENDAR,"complete":False},
                   {**APPROVED_TEST_CALENDAR,"approved":False},
                   {**APPROVED_TEST_CALENDAR,"coverage_end":"2026-10-03"},
                   {**APPROVED_TEST_CALENDAR,"coverage_start":"2026-10-03"},
                   {**APPROVED_TEST_CALENDAR,"holidays":["unverified"]},
                   {**APPROVED_TEST_CALENDAR,"reference":""},
                   {**APPROVED_TEST_CALENDAR,"holidays":None}]
        for calendar in calendars:
            with self.subTest(calendar=calendar),override_settings(REVIEW_BUSINESS_CALENDAR=calendar):
                with self.assertRaises(CalendarUnavailable):
                    review_deadline("Refund request",self.at("2026-10-02T12:00:00"))

    def test_explicit_demo_fixture_never_becomes_approved(self):
        with override_settings(REVIEW_BUSINESS_CALENDAR=None):
            _,basis=review_deadline("Refund request",self.at("2026-10-02T12:00:00"),synthetic=True)
            self.assertEqual(basis["status"],"synthetic")
            self.assertIn("NOT an approved",basis["reference"])


class CalendarWorkflowTests(TestCase):
    def setUp(self):
        self.org,self.actor=seed_demo()
        self.user=get_user_model().objects.create_user("calendar-maker@example.invalid")
        self.actor.user=self.user;self.actor.save()
        StaffMembership.objects.create(organisation=self.org,user=self.user,role="Preparer")
        reviewer=get_user_model().objects.create_user("calendar-reviewer@example.invalid")
        StaffMembership.objects.create(organisation=self.org,user=reviewer,role="Reviewer")
        self.client.force_login(self.user)
        session=self.client.session
        session.update({"staff_org":str(self.org.pk),"verified_at":time.time(),"staff_idle_at":time.time()});session.save()
        self.payment=Payment.objects.filter(organisation=self.org,status="Confirmed").first()
        self.path=f"/refunds/{self.payment.pk}/new/"
        self.data={"amount":"1.00","reason":"Synthetic calendar workflow"}

    def test_staff_missing_calendar_blocks_get_and_crafted_post_without_mutations(self):
        before=(Refund.objects.count(),Review.objects.count(),Audit.objects.count())
        for response in (self.client.get(self.path),self.client.post(self.path,self.data)):
            self.assertContains(response,"Verified deadline unavailable")
            self.assertContains(response,"disabled")
        self.assertEqual(before,(Refund.objects.count(),Review.objects.count(),Audit.objects.count()))
        self.assertContains(self.client.get("/settings/"),"approved Nigerian holiday-calendar coverage")

    @override_settings(REVIEW_BUSINESS_CALENDAR=APPROVED_TEST_CALENDAR)
    def test_staff_approved_calendar_saves_snapshot_and_audit(self):
        self.assertEqual(self.client.post(self.path,self.data).status_code,302)
        review=Refund.objects.get(payment=self.payment).review
        self.assertEqual(review.deadline_basis["status"],"approved")
        self.assertEqual(review.deadline_basis["business_days"],2)
        self.assertEqual(approval_deadline_error(review),"")
        audit=Audit.objects.get(organisation=self.org,action="Refund requested")
        self.assertEqual(audit.after_state["deadline_basis"],review.deadline_basis)
        self.assertIn("deadline",audit.after_state)

    def reviewer(self, refund):
        user=get_user_model().objects.get(username="calendar-reviewer@example.invalid")
        client=Client();client.force_login(user)
        proof,raw=issue("fresh",user.username,user=user,organisation=self.org,role="Reviewer",minutes=5)
        proof.action="refund-approval";proof.target=str(refund.pk);proof.save()
        session=client.session
        session.update({"staff_org":str(self.org.pk),"verified_at":time.time(),"staff_idle_at":time.time(),"fresh_proof":raw});session.save()
        return client,proof

    @override_settings(REVIEW_BUSINESS_CALENDAR=APPROVED_TEST_CALENDAR)
    def test_missing_calendar_blocks_approval_preserves_proof_and_history_but_allows_rejection(self):
        self.client.post(self.path,self.data)
        refund=Refund.objects.get(payment=self.payment);client,proof=self.reviewer(refund)
        review=refund.review
        original=(review.deadline,review.deadline_basis, list(Audit.objects.values()))
        path=f"/access/refunds/{refund.pk}/"
        with override_settings(REVIEW_BUSINESS_CALENDAR=None):
            self.assertContains(client.post(path,{"decision":"approve","note":"Synthetic check"}),"Verified deadline unavailable")
            proof.refresh_from_db();refund.refresh_from_db();review.refresh_from_db()
            self.assertIsNone(proof.consumed_at);self.assertEqual(refund.status,"Requested")
            self.assertEqual(original,(review.deadline,review.deadline_basis,list(Audit.objects.values())))
            self.assertContains(client.post(path,{"decision":"reject","note":"Do not proceed"}),"Decision recorded")
        refund.refresh_from_db();self.assertEqual(refund.status,"Rejected")

    @override_settings(REVIEW_BUSINESS_CALENDAR=APPROVED_TEST_CALENDAR)
    def test_legacy_synthetic_changed_calendar_and_tampered_deadline_cannot_approve(self):
        self.client.post(self.path,self.data)
        refund=Refund.objects.get(payment=self.payment);review=refund.review
        client,_=self.reviewer(refund)
        original=review.deadline
        from datetime import timedelta
        review.deadline=original+timedelta(days=1)
        self.assertTrue(approval_deadline_error(review))
        review.deadline=original
        with override_settings(REVIEW_BUSINESS_CALENDAR={**APPROVED_TEST_CALENDAR,"reference":"New test revision"}):
            self.assertTrue(approval_deadline_error(review))
        for basis in ({},{"status":"synthetic"}):
            Review.objects.filter(pk=review.pk).update(deadline_basis=basis)
            self.assertContains(client.post(f"/access/refunds/{refund.pk}/",{"decision":"approve","note":"No verified basis"}),"stored deadline is retained")
            review.refresh_from_db();self.assertEqual(review.deadline,original)
        self.assertEqual(self.client.get(f"/reviews/{review.pk}/").status_code,302)
        Review.objects.filter(pk=review.pk).update(kind="Unclear match",deadline_basis={})
        self.assertContains(self.client.get(f"/reviews/{review.pk}/"),"Historical stored deadline")

    @override_settings(REVIEW_BUSINESS_CALENDAR=APPROVED_TEST_CALENDAR)
    def test_after_withdrawal_refund_uses_five_day_basis_and_same_staff_gate(self):
        self.client.post(self.path,self.data)
        refund=Refund.objects.get(payment=self.payment);review=refund.review
        review.kind="Refund after withdrawal"
        review.deadline,review.deadline_basis=review_deadline(review.kind)
        review.save()
        self.assertEqual(review.deadline_basis["business_days"],5)
        self.assertEqual(self.client.get(f"/reviews/{review.pk}/").url,f"/access/refunds/{refund.pk}/")
        client,proof=self.reviewer(refund)
        with override_settings(REVIEW_BUSINESS_CALENDAR=None):
            self.assertContains(client.post(f"/access/refunds/{refund.pk}/",{"decision":"approve","note":"Calendar missing"}),"Verified deadline unavailable")
        refund.refresh_from_db();proof.refresh_from_db()
        self.assertEqual(refund.status,"Requested");self.assertIsNone(proof.consumed_at)