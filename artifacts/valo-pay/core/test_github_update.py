import time
from datetime import timedelta
from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings
from django.utils import timezone
from .models import Audit, Instalment, Member, Organisation, Payment, PaymentRequest, Review
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


def visible_text(response):
    """The words a person reads on the page: no tags, scripts, styles or attribute values."""
    import html
    import re
    body = re.sub(r"(?s)<(script|style)\b.*?</\1>", " ", response.content.decode())
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", body)))


def nav_links(response, label):
    """The link texts of one sidebar navigation block, in order."""
    import re
    block = re.search(r'<nav aria-label="%s"[^>]*>(.*?)</nav>' % label, response.content.decode(), re.S).group(1)
    return [re.sub(r"<[^>]+>|\s+", " ", text).split(" , ")[0].strip().split("  ")[0].strip()
            for text in re.findall(r"<a [^>]*>(.*?)</a>", block, re.S)]


@override_settings(ALLOWED_HOSTS=["testserver"])
class OwnerRequestTests(TestCase):
    """The owner's 5 October requests, ported from GitHub onto this app: a sidebar in working-day order,
    plain words for Unknown, and a demo guide that is easy to follow while presenting."""

    def start(self):
        self.client.post("/demo/start/")
        return Organisation.objects.get(pk=self.client.session["org"])

    def test_sidebar_follows_the_working_day(self):
        self.start()
        response = self.client.get("/today/")
        self.assertEqual([t.split(" ")[0] if t.startswith("Reviews") else t for t in nav_links(response, "Main")],
                         ["Dashboard", "Collections", "Reviews", "Pay-by-bank", "Customers", "Reports"])
        self.assertEqual(nav_links(response, "Organisation"), ["Settings", "Credit Desk", "Cash Desk"])
        self.assertEqual(nav_links(response, "Demo"), ["Demo guide", "Start page"])
        text = visible_text(response)
        for group in ["Daily work", "Records", "Organisation", "Coming later", "Demo"]:
            self.assertIn(group, text)
        account = response.content.decode().split('<details class="acct">')[1].split("</details>")[0]
        self.assertIn("Switch simulated role", account)
        self.assertNotIn('href="/settings/"', account)

    def test_unknown_reads_plainly_but_keeps_its_name_in_data(self):
        org = self.start()
        inst = Instalment.objects.filter(organisation=org, loan__on_hold=False, paid=0).select_related("loan").first()
        request = PaymentRequest.objects.create(organisation=org, instalment=inst, reference="VP-DEMO-NO-RESULT", amount=inst.amount,
                                                status="Unknown", expires_at=timezone.now() + timedelta(days=1))
        review = Review.objects.get(organisation=org, kind="Unknown result")
        dashboard = visible_text(self.client.get("/today/"))
        for words in ["Payment result not known for Amara Okeke · Amara Okeke", "We do not know yet if this payment went through.",
                      "Payment results not known", "Do not ask for these payments again until the result is known."]:
            self.assertIn(words, dashboard)
        for path in ["/today/", "/payments/", "/payments/?filter=unknown", f"/payments/{request.pk}/", "/reviews/",
                     f"/reviews/{review.pk}/", f"/customers/{review.instalment.loan.customer_id}/", "/collections/", "/demo/guide/", "/",
                     "/reports/", f"/refunds/{Payment.objects.filter(organisation=org, status='Confirmed').first().pk}/new/"]:
            self.assertNotIn("Unknown", visible_text(self.client.get(path)), path)
        self.assertIn("Result not known", visible_text(self.client.get("/payments/")))
        self.assertIn("Stored request status: Result not known.", visible_text(self.client.get(f"/payments/{request.pk}/")))
        self.assertIn("VP-DEMO-NO-RESULT", visible_text(self.client.get("/payments/?filter=unknown")))
        self.assertIn("Amara Okeke", visible_text(self.client.get("/reviews/", {"q": "result not known"})))
        self.assertIn("Unknown result", self.client.get("/exports/reviews/").content.decode())
        s = self.client.session
        s["actor"] = Member.objects.get(organisation=org, role="Reviewer").pk
        s.save()
        blocked = self.client.post(f"/loans/{review.instalment.loan_id}/action/", {"action": "release", "reason": "Checked"}, follow=True)
        self.assertIn("A payment on this loan has no final result yet. This hold cannot be released", visible_text(blocked))
        self.assertTrue(type(review.instalment.loan).objects.get(pk=review.instalment.loan_id).on_hold)

    def test_guide_steps_say_what_to_do_and_who_you_are(self):
        self.start()
        guide = visible_text(self.client.get("/demo/guide/"))
        self.assertEqual(guide.count("On the page:"), 10)
        for words in ["As Ada Okafor (Admin)", "As Zainab Yusuf (Preparer)", "As Tunde Bello (Reviewer)",
                      "Choose ‘Demo guide’ under Demo in the sidebar."]:
            self.assertIn(words, guide)
        self.assertNotIn("Account menu", guide.split("Sample-data demo", 1)[1])
        response = self.client.post("/demo/guide/action/", {"step": 3}, follow=True)
        card = visible_text(response)
        for words in ["Step 3 of 10 · As Tunde Bello (Reviewer)", "Understand an unclear payment result",
                      "Read Problem and evidence. The payment must not be requested again."]:
            self.assertIn(words, card)
        self.assertIn("Then choose Cash Desk under Coming later in the sidebar.",
                      visible_text(self.client.post("/demo/guide/action/", {"step": 10}, follow=True)))
