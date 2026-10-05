import time
from django.test import TestCase, override_settings
from django.contrib.auth import get_user_model
from .models import Organisation, Member, Audit


@override_settings(ALLOWED_HOSTS=["testserver"])
class DemoFlowTests(TestCase):
    def test_gets_never_create_and_post_starts(self):
        for path in ("/", "/demo/", "/demo/start/", "/demo/restart/", "/demo/guide/", "/today/"):
            self.client.get(path)
        self.assertEqual(Organisation.objects.count(), 0)
        self.assertEqual(self.client.post("/demo/start/").status_code, 302)
        self.assertEqual(Organisation.objects.count(), 1)
        self.assertEqual(self.client.get("/demo/guide/").status_code, 200)
        self.client.post("/demo/start/")
        self.assertEqual(Organisation.objects.count(), 1)

    def test_steps_scoped_and_no_external_redirect(self):
        self.client.post("/demo/start/")
        oid = self.client.session["org"]
        for step in range(1, 11):
            r = self.client.post("/demo/guide/action/", {"step":step,"next":"https://evil.invalid"})
            self.assertEqual(r.status_code, 302)
            self.assertTrue(r["Location"].startswith("/"))
            actor = Member.objects.get(pk=self.client.session["actor"])
            self.assertEqual(str(actor.organisation_id), oid)
            self.assertIsNone(actor.user_id)
            self.assertEqual(self.client.get(r["Location"]).status_code, 200)
        self.assertEqual(self.client.post("/demo/guide/action/", {"step":"bad"}).status_code,403)

    def test_restart_confirmation_retains_old_and_unrelated(self):
        protected=Organisation.objects.create(name="Protected")
        self.client.post("/demo/start/")
        old=self.client.session["org"]
        old_audit=list(Audit.objects.filter(organisation_id=old).values())
        self.client.get("/demo/restart/")
        self.assertEqual(self.client.session["org"],old)
        self.assertEqual(self.client.post("/demo/restart/").status_code,403)
        self.client.post("/demo/restart/",{"confirm":"yes"})
        self.assertNotEqual(self.client.session["org"],old)
        self.assertTrue(Organisation.objects.filter(pk=protected.pk).exists())
        self.assertEqual(list(Audit.objects.filter(organisation_id=old).values()),old_audit)

    def test_staff_cannot_enter_or_switch(self):
        u=get_user_model().objects.create_user("demo-test@example.invalid")
        self.client.force_login(u)
        for path in ("/demo/start/","/demo/restart/","/demo/guide/action/"):
            self.assertEqual(self.client.post(path,{"confirm":"yes","step":"1"}).status_code,403)
        self.assertEqual(Organisation.objects.count(),0)

    def test_expiry_retains_data_but_cannot_continue(self):
        self.client.post("/demo/start/")
        s=self.client.session
        s["demo_idle_at"]=time.time()-1801
        s.save()
        self.assertEqual(self.client.get("/today/")["Location"],"/demo/")
        self.assertEqual(Organisation.objects.count(),1)

    def test_integrated_sandbox_regressions(self):
        from .models import Loan, Review, Instalment, PaymentRequest
        from .services import validate_csv
        from django.utils import timezone
        from datetime import timedelta
        self.client.post("/demo/start/")
        org=Organisation.objects.get(pk=self.client.session["org"])
        errors,_=validate_csv("customer_id,name\n",org)
        self.assertNotIn("customer_id",errors[0])
        self.assertNotIn("name",errors[0])
        for value in ("abc","²","1.5"):
            self.assertEqual(self.client.get("/payments/new/",{"instalment":value}).status_code,404)
        loan=Loan.objects.filter(organisation=org,consent_status="Not requested").first()
        self.client.post(f"/loans/{loan.pk}/action/",{"action":"withdraw","reason":"test"})
        loan.refresh_from_db()
        self.assertEqual(loan.consent_status,"Not requested")
        loan.status="Closed";loan.save()
        self.client.post(f"/loans/{loan.pk}/action/",{"action":"hold","reason":"test"})
        loan.refresh_from_db()
        self.assertFalse(loan.on_hold)
        review=Review.objects.filter(organisation=org).first()
        viewer=Member.objects.get(organisation=org,role="Viewer")
        self.assertEqual(self.client.post(f"/reviews/{review.pk}/",{"action":"assign","owner":viewer.pk}).status_code,404)
        review.status="Resolved";review.save()
        self.assertNotContains(self.client.get("/reviews/"),f'href="/reviews/{review.pk}/"')
        self.assertContains(self.client.get("/reviews/?filter=closed"),f'href="/reviews/{review.pk}/"')
        inst=Instalment.objects.filter(organisation=org).first()
        PaymentRequest.objects.create(organisation=org,instalment=inst,reference="EXPIRED-TEST",
            amount=100,expires_at=timezone.now()-timedelta(seconds=1))
        self.client.get("/today/")
        self.assertEqual(Audit.objects.filter(organisation=org,action="Payment request expired").first().actor_name,"System")

    def test_exports_preserve_schema_and_stored_provenance(self):
        import csv,io
        from .models import Payment, Review
        self.client.post("/demo/start/")
        org=self.client.session["org"]
        payment=Payment.objects.filter(organisation_id=org).first()
        payment.sample=False;payment.save()
        rows=list(csv.DictReader(io.StringIO(self.client.get("/exports/payments/").content.decode("utf-8-sig"))))
        self.assertEqual(next(r for r in rows if r["reference"]==payment.reference)["synthetic"],"False")
        self.assertFalse(Review._meta.get_field("owner").null)
        self.assertEqual(self.client.get("/exports/reviews/").status_code,200)
        for kind in ("customer","schedule"):
            self.assertEqual(self.client.get(f"/exports/{kind}/?customer=²").status_code,404)

    def test_choose_specific_loan_for_edit_without_cross_tenant_access(self):
        from .models import Loan
        from .services import seed_demo
        self.client.post("/demo/start/")
        org=self.client.session["org"]
        first=Loan.objects.filter(organisation_id=org).first()
        second=Loan.objects.create(organisation_id=org,customer=first.customer,
                                   reference="SECOND-LOAN",product="Second product")
        page=self.client.get(f"/customers/{first.customer_id}/edit/?loan={second.pk}")
        self.assertContains(page,'value="Second product"')
        self.assertContains(self.client.get(f"/customers/{first.customer_id}/"),f'edit/?loan={second.pk}')
        foreign,_=seed_demo()
        other=Loan.objects.filter(organisation=foreign).first()
        for selection in ("²",str(other.pk)):
            self.assertEqual(self.client.get(f"/customers/{first.customer_id}/edit/?loan={selection}").status_code,404)