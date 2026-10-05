import time
from datetime import timedelta
from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings
from django.utils import timezone
from .models import Audit, Instalment, Member, Organisation, Payment, PaymentRequest
from .services import seed_demo


@override_settings(ALLOWED_HOSTS=["testserver"])
class GithubUpdateTests(TestCase):
    def start(self):
        self.client.post("/demo/start/")
        return Organisation.objects.get(pk=self.client.session["org"])

    def test_dashboard_and_tour(self):
        self.start()
        response = self.client.get("/today/")
        self.assertContains(response, "<h1>Dashboard</h1>", html=True)
        self.assertContains(response, "Run today's sample debits")
        self.assertLess(response.content.index(b'id="due-today"'), response.content.index(b'class="grid g2"'))
        self.assertEqual(self.client.post("/demo/guide/action/", {"step": 1}).status_code, 302)
        self.assertContains(self.client.get("/today/"), "Step 1 of 10")
        for n in range(2, 11):
            response = self.client.post("/demo/guide/action/", {"step": n}, follow=True)
            self.assertEqual(response.status_code, 200)
            self.assertContains(response, f"Step {n} of 10")
        self.client.post("/demo/guide/end/")
        self.assertNotContains(self.client.get("/today/"), "Demo tour controls")
        self.client.post("/demo/guide/action/", {"step": 1})
        self.client.post("/demo/restart/", {"confirm": "yes"})
        self.assertNotIn("demo_tour_step", self.client.session)

    def test_sample_run_is_idempotent_and_tenant_scoped(self):
        org = self.start()
        other, _ = seed_demo()
        other_before = list(Instalment.objects.filter(organisation=other).values_list("pk", "paid", "state"))
        before = Payment.objects.filter(organisation=org).count()
        response = self.client.post("/demo/debits/run/", follow=True)
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Sample run: 2 collected, 1 failed")
        self.assertEqual(Payment.objects.filter(organisation=org).count(), before + 2)
        self.assertEqual(Payment.objects.filter(organisation=org, sample=False).count(), 0)
        outcomes = list(Instalment.objects.filter(organisation=org).values_list("pk", "paid", "state"))
        self.client.post("/demo/debits/run/")
        self.assertEqual(list(Instalment.objects.filter(organisation=org).values_list("pk", "paid", "state")), outcomes)
        self.assertEqual(Payment.objects.filter(organisation=org).count(), before + 2)
        self.assertEqual(list(Instalment.objects.filter(organisation=other).values_list("pk", "paid", "state")), other_before)
        self.assertEqual(Audit.objects.filter(organisation=org, action="Sample debit outcome", schema_version=2).count(), 3)

    def test_blockers_and_invalid_session_cannot_run(self):
        org = self.start()
        due = list(Instalment.objects.filter(organisation=org, due_date=timezone.localdate(),
                                            loan__consent_status="Active").select_related("loan"))
        due[0].loan.on_hold = True
        due[0].loan.save()
        due[1].loan.consent_expiry = timezone.localdate() - timedelta(days=1)
        due[1].loan.save()
        PaymentRequest.objects.create(organisation=org, instalment=due[2], reference="BLOCK-UNKNOWN",
                                      amount=due[2].amount, status="Unknown",
                                      expires_at=timezone.now()+timedelta(days=1))
        before = Payment.objects.count()
        self.client.post("/demo/debits/run/")
        self.assertEqual(Payment.objects.count(), before)
        s = self.client.session
        s.pop("demo_flow_org")
        s.save()
        self.assertEqual(self.client.post("/demo/debits/run/").status_code, 403)

    def test_staff_viewer_real_records_and_expired_session_are_rejected(self):
        org = self.start()
        s = self.client.session
        s["actor"] = Member.objects.get(organisation=org, role="Viewer").pk
        s.save()
        self.assertEqual(self.client.post("/demo/debits/run/").status_code, 403)
        s = self.client.session
        s["actor"] = Member.objects.get(organisation=org, role="Admin").pk
        s.save()
        Payment.objects.filter(organisation=org).update(sample=False)
        self.assertEqual(self.client.post("/demo/debits/run/").status_code, 403)
        Payment.objects.filter(organisation=org).update(sample=True)
        user = get_user_model().objects.create_user("protected@example.invalid")
        Member.objects.filter(organisation=org, role="Reviewer").update(user=user)
        self.assertEqual(self.client.post("/demo/debits/run/").status_code, 403)
        Member.objects.filter(organisation=org, role="Reviewer").update(user=None)
        s = self.client.session
        s["demo_idle_at"] = time.time() - 1801
        s.save()
        self.assertIn(self.client.post("/demo/debits/run/").status_code, (302, 403))
        self.client.force_login(user)
        self.assertEqual(self.client.post("/demo/debits/run/").status_code, 403)
        self.assertEqual(self.client.post("/demo/guide/end/").status_code, 403)

    def test_post_and_csrf_required(self):
        self.start()
        self.assertEqual(self.client.get("/demo/debits/run/").status_code, 405)
        self.assertEqual(self.client.get("/demo/guide/end/").status_code, 405)
        csrf_client = Client(enforce_csrf_checks=True)
        csrf_client.cookies = self.client.cookies
        self.assertEqual(csrf_client.post("/demo/debits/run/").status_code, 403)
        self.assertEqual(csrf_client.post("/demo/guide/end/").status_code, 403)
