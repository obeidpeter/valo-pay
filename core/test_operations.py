from datetime import timedelta
import time
from django.test import Client, TestCase, tag
from django.utils import timezone
from django.contrib.auth import get_user_model
from .models import *
from .services import seed_demo


class VerifiedOperationsTests(TestCase):
    def setUp(self):
        self.user=get_user_model().objects.create_user("ops@example.invalid",password="synthetic-operations-pass")
        self.org=Organisation.objects.create(name="Empty verified organisation")
        self.member=StaffMembership.objects.create(user=self.user,organisation=self.org,role="Admin")
        self.client.force_login(self.user)
        session=self.client.session
        session.update({"verified_at":time.time(),"staff_idle_at":time.time(),"staff_org":str(self.org.pk)})
        session.save()

    def test_staff_routes_empty_no_seed_and_role_switch_denied(self):
        for path in ("/today/","/customers/","/import/","/collections/","/payments/","/reviews/","/reports/","/settings/","/exports/payments/"):
            self.assertEqual(self.client.get(path).status_code,200,path)
        self.assertFalse(Customer.objects.filter(organisation=self.org).exists())
        self.assertEqual(self.client.post("/demo-role/",{"member":1}).status_code,403)
        self.assertNotContains(self.client.get("/settings/"),'action="/demo-role/"')

    def test_viewer_and_revocation(self):
        self.member.role="Viewer";self.member.save()
        for path in ("/payments/new/","/customers/new/","/import/"):
            self.assertEqual(self.client.get(path).status_code,403)
        self.assertContains(self.client.get("/payments/new/"),"This action is not available",status_code=403)
        self.assertEqual(self.client.post("/settings/",{"name":"Forged"}).status_code,403)
        self.member.active=False;self.member.save()
        for path in ("/today/","/customers/","/exports/payments/"):
            self.assertEqual(self.client.get(path).status_code,403)

    def test_switch_changes_every_query_and_export(self):
        org,actor=seed_demo()
        membership=StaffMembership.objects.create(user=self.user,organisation=org,role="Viewer")
        customer=Customer.objects.filter(organisation=org).first()
        self.assertEqual(self.client.get(f"/customers/{customer.pk}/").status_code,404)
        self.client.post("/access/organisations/",{"organisation":membership.pk})
        self.assertEqual(self.client.get(f"/customers/{customer.pk}/").status_code,200)
        self.assertContains(self.client.get("/exports/payments/"),"DEMO-")
        self.client.post("/access/organisations/",{"organisation":self.member.pk})
        self.assertNotContains(self.client.get("/exports/payments/"),"DEMO-")
        self.assertEqual(self.client.get(f"/customers/{customer.pk}/").status_code,404)

    def test_deactivated_user_cannot_enter_operations(self):
        self.user.is_active=False;self.user.save()
        self.assertEqual(self.client.get("/today/").status_code,302)

    def test_active_navigation_renews_but_background_does_not(self):
        headers={"HTTP_SEC_FETCH_MODE":"navigate","HTTP_SEC_FETCH_DEST":"document","HTTP_SEC_FETCH_USER":"?1"}
        session=self.client.session;session["staff_idle_at"]=time.time()-1790;session.save()
        self.assertEqual(self.client.get("/customers/?q=synthetic",**headers).status_code,200)
        self.assertLess(time.time()-self.client.session["staff_idle_at"],5)
        session=self.client.session;session["staff_idle_at"]=time.time()-1790;session.save()
        before=self.client.session["staff_idle_at"]
        self.client.get("/reports/",HTTP_SEC_FETCH_MODE="cors",HTTP_SEC_FETCH_DEST="empty")
        self.assertEqual(self.client.session["staff_idle_at"],before)
        session=self.client.session;session["staff_idle_at"]=time.time()-1801;session.save()
        response=self.client.get("/reports/?filter=confirmed",HTTP_SEC_FETCH_MODE="cors")
        self.assertEqual(response.status_code,302)
        self.assertNotIn("_auth_user_id",self.client.session)

    def test_safe_read_returns_and_no_mutation_paths(self):
        from .access_services import safe_next
        self.assertEqual(safe_next("/customers/?q=Test&filter=active&next=https://evil.example"),"/customers/?q=Test&filter=active")
        self.assertEqual(safe_next("/reports/?page=2"),"/reports/?page=2")
        for path in ("/loans/1/action/","/payments/1/cancel/","/access/logout/","/customers/%2e%2e/settings/","//evil.example"):
            self.assertEqual(safe_next(path),"/access/organisations/")

    def test_all_roles_render_authorised_actions_only(self):
        org,prep=seed_demo()
        loan=Loan.objects.filter(organisation=org,on_hold=False).first()
        review=Review.objects.filter(organisation=org).first()
        self.member.organisation=org
        session=self.client.session;session["staff_org"]=str(org.pk);session.save()
        for role in ("Viewer","Reviewer","Preparer","Admin"):
            with self.subTest(role=role):
                self.member.role=role;self.member.save()
                today=self.client.get("/today/")
                customer=self.client.get(f"/customers/{loan.customer_id}/")
                collections=self.client.get("/collections/")
                settings=self.client.get("/settings/")
                reviews=self.client.get(f"/reviews/{review.pk}/")
                if role in ("Admin","Preparer"):
                    self.assertContains(today,'href="/payments/new/"')
                    self.assertContains(customer,"Edit details")
                    self.assertContains(customer,"Create consent link")
                else:
                    self.assertNotContains(today,'href="/payments/new/"')
                    self.assertNotContains(customer,"Edit details")
                    self.assertNotContains(customer,'name="action" value="consent"')
                    self.assertNotContains(collections,'href="/payments/new/?')
                if role=="Viewer":
                    self.assertContains(customer,"Read-only")
                    self.assertNotContains(customer,'action="/loans/')
                    self.assertNotContains(reviews,"Save owner")
                if role!="Admin":
                    self.assertNotContains(settings,">Save settings</button>")
                if role in ("Viewer","Preparer"):
                    self.assertNotContains(reviews,">Record decision</button>")
        self.client.logout()
        viewer=Member.objects.create(organisation=org,name="Synthetic viewer",role="Viewer")
        session=self.client.session;session.update({"org":str(org.pk),"actor":viewer.pk});session.save()
        self.assertEqual(self.client.get(f"/customers/{loan.customer_id}/").status_code,403)
        demo_org,_=seed_demo()
        demo_viewer=Member.objects.get(organisation=demo_org,role="Viewer")
        demo_loan=Loan.objects.filter(organisation=demo_org).first()
        session=self.client.session;session.update({"org":str(demo_org.pk),"actor":demo_viewer.pk});session.save()
        self.assertNotContains(self.client.get(f"/customers/{demo_loan.customer_id}/"),'action="/loans/')

    def test_legacy_mutations_require_verified_role_and_tenant(self):
        org,actor=seed_demo()
        loan=Loan.objects.filter(organisation=org).first()
        payment=Payment.objects.filter(organisation=org).first()
        review=Review.objects.filter(organisation=org).first()
        paths=[f"/loans/{loan.pk}/action/",f"/refunds/{payment.pk}/new/",f"/reviews/{review.pk}/"]
        for path in paths:
            self.assertEqual(self.client.post(path,{"action":"resolve","outcome":"Resolved","reason":"Synthetic","amount":"1"}).status_code,404)
        self.member.organisation=org;self.member.role="Viewer";self.member.save()
        session=self.client.session;session["staff_org"]=str(org.pk);session.save()
        for path in paths:
            self.assertEqual(self.client.post(path,{"action":"resolve","outcome":"Resolved"}).status_code,403)
        session=self.client.session;session.pop("verified_at",None);session.save()
        for path in paths:
            self.assertEqual(self.client.post(path,{"action":"resolve","outcome":"Resolved"}).status_code,302)

    def test_customer_corrections_hold_independence_close_and_audit(self):
        data={"name":"Synthetic Customer","external_id":"CREATE-1","email":"fixture@example.invalid","phone":"",
              "loan_id":"CREATE-L1","product":"Synthetic","amount":"100.00","due_date":"2027-01-01","instalment_count":2}
        self.assertEqual(self.client.post("/customers/new/",data).status_code,302)
        customer=Customer.objects.get(organisation=self.org,external_id="CREATE-1")
        loan=customer.loans.get()
        self.assertEqual(loan.instalments.count(),2)
        self.assertEqual(self.client.post(f"/customers/{customer.pk}/edit/",{**data,"name":"Corrected Synthetic","change_reason":"Fix spelling"}).status_code,302)
        event=Audit.objects.get(action="Customer updated",organisation=self.org)
        self.assertEqual(event.before_state["name"],"Synthetic Customer")
        self.assertEqual(event.after_state["name"],"Corrected Synthetic")
        self.assertEqual(event.reason,"Fix spelling")
        self.assertEqual(event.customer_ids,[str(customer.pk)])
        path=f"/loans/{loan.pk}/action/"
        self.client.post(path,{"action":"consent"})
        self.client.post(path,{"action":"hold","reason":"Synthetic dispute"})
        self.client.post(path,{"action":"release","reason":"Cannot self-review"})
        loan.refresh_from_db();self.assertTrue(loan.on_hold)
        user=get_user_model().objects.create_user("reviewer@example.invalid")
        StaffMembership.objects.create(user=user,organisation=self.org,role="Reviewer")
        reviewer=Client();reviewer.force_login(user)
        session=reviewer.session;session.update({"staff_org":str(self.org.pk),"staff_idle_at":time.time(),"verified_at":time.time()});session.save()
        reviewer.post(path,{"action":"release","reason":"Independently checked"})
        loan.refresh_from_db();self.assertFalse(loan.on_hold)
        inst=loan.instalments.first()
        self.client.post("/payments/new/",{"instalment":inst.pk,"amount":"1.00","expiry_hours":24,"confirmed":"on"})
        self.client.post(path,{"action":"withdraw","reason":"Borrower instruction"})
        self.client.post(path,{"action":"close","reason":"Synthetic closure"})
        loan.refresh_from_db();self.assertEqual(loan.status,"Closed")
        self.assertEqual(PaymentRequest.objects.get(instalment=inst).status,"Cancelled")
        cancelled=Audit.objects.get(organisation=self.org,action="Payment request cancelled")
        self.assertEqual(cancelled.before_state,{"status":"Awaiting approval"})
        self.assertEqual(cancelled.customer_ids,[str(customer.pk)])
        self.client.post("/settings/",{"name":self.org.name,"retry_preset":"Gentle"})
        for export in ("customer/?customer="+str(customer.pk),"audit/","consents/","reviews/","daily/","template/"):
            self.assertEqual(self.client.get("/exports/"+export).status_code,200)


class WorkflowCorrectionTests(TestCase):
    def setUp(self):
        self.org,self.actor=seed_demo()
        session=self.client.session
        session.update({"org":str(self.org.pk),"actor":self.actor.pk,"demo_mode":True})
        session.save()

    def csv(self,count=1):
        return "customer_id,name,email,phone,loan_id,product,amount,due_date\n"+"\n".join(
            f"T{n},Synthetic {n},row{n}@example.invalid,,L{n},Test,100.00,2027-01-01" for n in range(count))

    def test_import_exact_preview_count_and_replay(self):
        text=self.csv(51)
        preview=self.client.post("/import/",{"action":"validate","csv_data":text})
        self.assertEqual(preview.context["total_rows"],51)
        self.assertEqual(len(preview.context["preview"]),50)
        payload={"action":"commit","csv_data":text,"preview_id":str(preview.context["preview_id"])}
        tampered=self.client.post("/import/",{**payload,"csv_data":text.replace("100.00","101.00")})
        self.assertContains(tampered,"Validate this exact file again")
        self.assertEqual(self.client.post("/import/",payload).status_code,302)
        self.assertContains(self.client.post("/import/",payload),"nothing was imported",html=False)
        self.assertEqual(Customer.objects.filter(organisation=self.org,external_id__startswith="T").count(),51)

    def test_import_missing_expired_foreign_session(self):
        text=self.csv()
        self.assertContains(self.client.post("/import/",{"action":"commit","csv_data":text}),"Validate this exact file again")
        preview=self.client.post("/import/",{"action":"validate","csv_data":text})
        token=preview.context["preview_id"]
        ImportPreview.objects.filter(pk=token).update(expires_at=timezone.now()-timedelta(seconds=1))
        self.assertContains(self.client.post("/import/",{"action":"commit","csv_data":text,"preview_id":str(token)}),"Validate this exact file again")

    def test_borrower_authoritative_states_after_expiry(self):
        inst=Instalment.objects.filter(organisation=self.org,state="Upcoming",loan__on_hold=False).first()
        item=PaymentRequest.objects.create(organisation=self.org,instalment=inst,reference="SYNTHETIC-STATE",amount=100,expires_at=timezone.now()-timedelta(days=1))
        for status,heading in [("Confirmed","Payment confirmed"),("Unknown","Payment result unresolved"),("Awaiting confirmation","Awaiting confirmation"),("Cancelled","Request cancelled"),("Used","Request already used"),("Reversed","Payment reported reversed"),("Failed","Payment attempt reported failed")]:
            item.status=status;item.save()
            response=self.client.get(f"/pay/{item.token}/?status=success")
            self.assertContains(response,heading)
            self.assertNotContains(response,"Continue to payment provider")
            self.assertNotContains(response,"No payment or authorisation was taken")
            self.assertEqual(response["Cache-Control"],"no-store")
            self.assertIn("noindex",response["X-Robots-Tag"])
            self.assertEqual(response["Referrer-Policy"],"same-origin")

    def test_closed_consent_and_purpose_mismatch(self):
        loan=Loan.objects.filter(organisation=self.org).first()
        loan.consent_status="Requested";loan.consent_requested_at=timezone.now();loan.status="Closed";loan.save()
        self.assertContains(self.client.get(f"/consent/{loan.consent_token}/"),"Authorisation link unavailable")
        response=self.client.get(f"/pay/{loan.consent_token}/")
        self.assertEqual(response.status_code,404)
        self.assertNotContains(response,'href="/today/"',status_code=404)

    @tag("performance")
    def test_import_5000_measured_and_history_scoped(self):
        import json
        from pathlib import Path
        text=self.csv(5000)
        started=time.perf_counter()
        result=self.client.post("/import/",{"action":"validate","csv_data":text})
        preview_seconds=time.perf_counter()-started
        self.assertEqual(result.context["total_rows"],5000)
        self.assertEqual(len(result.context["preview"]),50)
        started=time.perf_counter()
        result=self.client.post("/import/",{"action":"commit","csv_data":text,"preview_id":str(result.context["preview_id"])})
        commit_seconds=time.perf_counter()-started
        self.assertEqual(result.status_code,302)
        self.assertEqual(Customer.objects.filter(organisation=self.org,external_id__startswith="T").count(),5000)
        history=Audit.objects.get(organisation=self.org,action="CSV imported")
        self.assertEqual(len(history.customer_ids),5000)
        self.assertEqual(history.after_state["rows"],5000)
        listing=self.client.get("/customers/")
        self.assertEqual(len(listing.context["customers"]),50)
        result={"rows":5000,"preview_rows":50,"preview_seconds":preview_seconds,"commit_seconds":commit_seconds,
                "csv_bytes":len(text.encode()),"atomic":True,"database":"isolated PostgreSQL test database",
                "customer_page_bytes":len(listing.content)}
        Path("evidence").mkdir(exist_ok=True)
        Path("evidence/import-5000.json").write_text(json.dumps(result,indent=2))
        print("5000-row import:",json.dumps(result))