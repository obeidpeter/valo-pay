import csv
import io
from datetime import datetime, timezone as dtzone
from unittest.mock import patch
from django.test import Client, TestCase
from .models import *
from .services import seed_demo
from .views import metrics


class LocalCompletionTests(TestCase):
    def setUp(self):
        self.org,self.actor=seed_demo()
        session=self.client.session
        session.update({"org":str(self.org.pk),"actor":self.actor.pk,"demo_mode":True})
        session.save()

    def test_foreign_session_preview_cannot_commit(self):
        text="customer_id,name,email,phone,loan_id,product,amount,due_date\nFOREIGN,Synthetic,,,,Test,100,2027-01-01"
        text=text.replace("Synthetic,,,,","Synthetic,,,FOREIGN-L,")
        preview=self.client.post("/import/",{"action":"validate","csv_data":text})
        other=Client();s=other.session
        s.update({"org":str(self.org.pk),"actor":self.actor.pk,"demo_mode":True});s.save()
        payload={"action":"commit","csv_data":text,"preview_id":str(preview.context["preview_id"])}
        self.assertContains(other.post("/import/",payload),"Validate this exact file again")
        self.assertFalse(Customer.objects.filter(external_id="FOREIGN").exists())
        self.assertEqual(self.client.post("/import/",payload).status_code,302)

    def test_empty_records_edit_and_scoped_history(self):
        c=Customer.objects.create(organisation=self.org,external_id="EMPTY",name="Synthetic empty")
        for with_loan in (False,True):
            if with_loan: Loan.objects.create(organisation=self.org,customer=c,reference="EMPTY-L")
            self.assertEqual(self.client.get(f"/customers/{c.pk}/").status_code,200)
            self.assertEqual(self.client.get(f"/customers/{c.pk}/edit/").status_code,200)
            self.assertEqual(self.client.post(f"/customers/{c.pk}/edit/",{"name":"Corrected","external_id":"EMPTY","email":"","phone":"","product":"Test","change_reason":"Correction"}).status_code,302)
            self.assertEqual(Instalment.objects.filter(loan__customer=c).count(),0)
        rows=list(csv.DictReader(io.StringIO(self.client.get(f"/exports/customer/?customer={c.pk}").content.decode("utf-8-sig"))))
        self.assertEqual(len(rows),2)
        self.assertEqual(rows[0]["reason"],"Correction")
        self.assertIn("before",rows[0]);self.assertIn("after",rows[0])
        self.assertNotContains(self.client.get(f"/exports/customer/?customer={c.pk}"),"Demo workspace created")
        self.assertContains(self.client.get(f"/exports/schedule/?customer={c.pk}"),"due_date")

    def test_collection_scope_and_pagination_context(self):
        first=self.client.get("/collections/?q=Amara&filter=hold")
        self.assertEqual(first.context["page_obj"].paginator.count,6)
        all_rows=self.client.get("/collections/?page=2")
        self.assertContains(all_rows,"of 72 matching instalments")
        self.assertContains(all_rows,"Scheduled amount")
        self.assertEqual(all_rows.context["dataset_amount"],self.client.get("/collections/").context["dataset_amount"])
        self.assertContains(first,"q=Amara",html=False)
        viewer=Member.objects.get(organisation=self.org,role="Viewer")
        s=self.client.session;s["actor"]=viewer.pk;s.save()
        self.assertNotContains(self.client.get("/collections/"),'href="/payments/new/')
        self.assertNotContains(self.client.get("/collections/?q=no-match"),'href="/import/"')

    def test_wat_month_and_instalment_exclusions(self):
        Payment.objects.filter(organisation=self.org).delete()
        loan=Loan.objects.filter(organisation=self.org,on_hold=False).first()
        insts=list(loan.instalments.order_by("pk"))
        now=datetime(2026,10,1,0,0,0,456789,tzinfo=dtzone.utc)
        at_boundary=datetime(2026,9,30,23,0,tzinfo=dtzone.utc)
        for n,inst in enumerate(insts[:5]):
            Payment.objects.create(organisation=self.org,instalment=inst,reference=f"WAT-{n}",amount=100*(n+1),status="Confirmed",paid_at=at_boundary)
        Review.objects.create(organisation=self.org,instalment=insts[1],kind="Unclear match",status="Open",deadline=now,owner=self.actor,prepared_by=self.actor)
        insts[2].state="Unknown";insts[2].save()
        insts[3].state="In progress";insts[3].save()
        Payment.objects.filter(reference="WAT-4").update(paid_at=datetime(2026,9,30,22,59,59,tzinfo=dtzone.utc))
        Instalment.objects.filter(organisation=self.org).update(due_date="2026-10-01")
        with patch("django.utils.timezone.now",return_value=now):
            result=metrics(self.org)
            self.assertEqual(result["confirmed_count"],1)
            self.assertEqual(result["collected_display"],"₦1.00")
            self.assertEqual(result["due_count"],60)
        with patch("django.utils.timezone.now",return_value=datetime(2026,9,30,22,59,59,tzinfo=dtzone.utc)):
            self.assertEqual(metrics(self.org)["due_count"],0)

    def test_crafted_edit_cannot_replace_schedule(self):
        loan=Loan.objects.filter(organisation=self.org).first()
        customer=loan.customer
        before=list(loan.instalments.order_by("pk").values("pk","amount","paid","due_date","sequence","state"))
        response=self.client.post(f"/customers/{customer.pk}/edit/",{
            "name":customer.name,"external_id":customer.external_id,"email":customer.email,
            "phone":customer.phone,"product":loan.product,"change_reason":"Contact correction",
            "amount":"0.01","due_date":"2099-12-31","instalment_count":120,"loan_id":"FORGED"})
        self.assertEqual(response.status_code,302)
        self.assertEqual(before,list(loan.instalments.order_by("pk").values("pk","amount","paid","due_date","sequence","state")))
        loan.refresh_from_db();self.assertNotEqual(loan.reference,"FORGED")