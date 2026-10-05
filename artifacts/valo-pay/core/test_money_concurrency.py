from concurrent.futures import ThreadPoolExecutor
from django.test import TransactionTestCase, Client, override_settings
from django.db import connections
from .models import *
from .services import seed_demo
from .test_business_days import APPROVED_TEST_CALENDAR


class MoneyConcurrencyTests(TransactionTestCase):
    def setUp(self):
        self.org,self.actor=seed_demo()
        self.client=Client()
        session=self.client.session
        session.update({"org":str(self.org.pk),"actor":self.actor.pk,"demo_mode":True})
        session.save()

    def parallel(self,path,payload):
        cookies=self.client.cookies.copy()
        def execute(_):
            try:
                client=Client();client.cookies=cookies.copy()
                return client.post(path,payload).status_code
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:
            return list(pool.map(execute,range(2)))

    def test_postgresql_parallel_import_consumes_once(self):
        text="customer_id,name,email,phone,loan_id,product,amount,due_date\nRACE,Synthetic Race,race@example.invalid,,RACE-L,Test,100,2027-01-01"
        response=self.client.post("/import/",{"action":"validate","csv_data":text})
        payload={"action":"commit","csv_data":text,"preview_id":str(response.context["preview_id"])}
        self.assertEqual(sorted(self.parallel("/import/",payload)),[200,302])
        self.assertEqual(Customer.objects.filter(organisation=self.org,external_id="RACE").count(),1)
        self.assertEqual(Loan.objects.filter(organisation=self.org,reference="RACE-L").count(),1)
        self.assertEqual(Audit.objects.filter(organisation=self.org,action="CSV imported").count(),1)

    def test_parallel_request_and_refund_do_not_duplicate(self):
        inst=Instalment.objects.filter(organisation=self.org,loan__on_hold=False,state="Upcoming").first()
        self.parallel("/payments/new/",{"instalment":inst.pk,"amount":"1.00","expiry_hours":24,"confirmed":"on"})
        self.assertEqual(PaymentRequest.objects.filter(instalment=inst,status="Awaiting approval").count(),1)
        payment=Payment.objects.filter(organisation=self.org,status="Confirmed").first()
        self.parallel(f"/refunds/{payment.pk}/new/",{"amount":"1.00","reason":"Synthetic concurrent refund"})
        self.assertEqual(Refund.objects.filter(payment=payment,reason="Synthetic concurrent refund").count(),1)

    def test_differing_refunds_cannot_overreserve(self):
        payment=Payment.objects.filter(organisation=self.org,status="Confirmed").first()
        payment.amount=10000;payment.save()
        cookies=self.client.cookies.copy()
        def submit(amount):
            try:
                client=Client();client.cookies=cookies.copy()
                return client.post(f"/refunds/{payment.pk}/new/",{"amount":amount,"reason":"Different concurrent reservation"}).status_code
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses=list(pool.map(submit,["60.00","70.00"]))
        self.assertEqual(sorted(statuses),[200,302])
        self.assertEqual(Refund.objects.filter(payment=payment).count(),1)
        self.assertLessEqual(Refund.objects.get(payment=payment).amount,payment.amount)

    @override_settings(REVIEW_BUSINESS_CALENDAR=APPROVED_TEST_CALENDAR)
    def test_parallel_staff_decision_consumes_fresh_once(self):
        import time
        from django.contrib.auth import get_user_model
        from .access_services import issue
        maker=get_user_model().objects.create_user("race-maker@example.invalid")
        self.actor.user=maker;self.actor.save()
        reviewer=get_user_model().objects.create_user("race-reviewer@example.invalid")
        StaffMembership.objects.create(user=reviewer,organisation=self.org,role="Reviewer")
        payment=Payment.objects.filter(organisation=self.org,status="Confirmed").first()
        review=Review.objects.create(organisation=self.org,instalment=payment.instalment,
            kind="Refund request",amount=100,owner=self.actor,prepared_by=self.actor,deadline=timezone.now())
        from .business_days import review_deadline
        review.deadline,review.deadline_basis=review_deadline(review.kind)
        review.save(update_fields=["deadline","deadline_basis"])
        refund=Refund.objects.create(organisation=self.org,payment=payment,review=review,amount=100,reason="Synthetic race")
        proof,raw=issue("fresh",reviewer.username,user=reviewer,organisation=self.org,role="Reviewer",minutes=5)
        proof.action="refund-approval";proof.target=str(refund.pk);proof.save()
        self.client.force_login(reviewer)
        session=self.client.session
        session.update({"staff_org":str(self.org.pk),"staff_idle_at":time.time(),"verified_at":time.time(),"fresh_proof":raw});session.save()
        statuses=self.parallel(f"/access/refunds/{refund.pk}/",{"decision":"approve","note":"Independent synthetic decision"})
        self.assertEqual(statuses,[200,200])
        refund.refresh_from_db();proof.refresh_from_db()
        self.assertEqual(refund.status,"Approved")
        self.assertIsNotNone(proof.consumed_at)
        self.assertEqual(Audit.objects.filter(organisation=self.org,action="Staff refund decision").count(),1)