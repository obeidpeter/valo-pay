"""The demo's own navigation: the start page, starting again and the demo guide."""
import re

from django.test import Client

from core.models import Member, Organisation, PaymentRequest, Refund, Review
from .test_copy import CopyTestCase, read


class StartPageTests(CopyTestCase):
    def test_start_page_is_reachable_from_inside_the_demo(self):
        self.assertIn('href="/start/"', self.client.get("/").content.decode())
        response = self.client.get("/start/")
        self.assertTemplateUsed(response, "start.html")
        text = self.check(response, "start page with a workspace")
        for words in ["Continue the demo", "Start again with fresh sample data", "Demo guide"]:
            self.assertIn(words, text)
        self.assertNotIn("Open the demo workspace", text)
        self.assertEqual(Organisation.objects.count(), 1)

    def test_start_again_replaces_the_workspace(self):
        old = self.org.pk
        self.act_as("Tunde Bello")
        response = self.client.post("/start/", {"restart": "1"}, follow=True)
        self.assertTemplateUsed(response, "today.html")
        self.assertIn("A fresh demo workspace is ready, with new sample data.", " ".join(self.messages_in(response)))
        new = Organisation.objects.get()
        self.assertNotEqual(str(new.pk), str(old))
        self.assertEqual(self.client.session["org"], str(new.pk))
        self.assertIn("Acting as Ada Okafor Admin", read(response.content.decode()).text())

    def test_a_plain_open_never_replaces_a_workspace(self):
        self.client.post("/start/")
        self.assertEqual(Organisation.objects.get().pk, self.org.pk)

    def test_start_again_without_a_workspace_opens_one(self):
        visitor = Client()
        visitor.post("/start/", {"restart": "1"})
        self.assertEqual(Organisation.objects.count(), 2)
        self.assertIn("Good day", visitor.get("/").content.decode())


class GuideTests(CopyTestCase):
    def test_guide_renders_for_every_role_and_its_links_open(self):
        for name in ["Ada Okafor", "Tunde Bello", "Zainab Yusuf", "Emeka Obi"]:
            self.act_as(name)
            response = self.client.get("/guide/")
            self.assertEqual(response.status_code, 200, name)
            self.check(response, f"guide as {name}")
            html = response.content.decode()
            main = html[html.index('<main class="main">'):]
            for href in sorted(set(re.findall(r'href="(/[^"]*)"', main))):
                self.assertIn(self.client.get(href).status_code, [200], f"{href} from the guide as {name}")

    def test_steps_point_at_the_sample_records(self):
        html = self.client.get("/guide/").content.decode()
        for customer in ["Chidi Nwosu", "Amara Okeke", "Oluwaseun Adeyemi"]:
            self.assertIn(f'href="/customers/{self.loan_of(customer).customer_id}/"', html)
        self.assertIn(f'href="/reviews/{self.review("Consent problem").id}/"', html)
        self.assertRegex(html, r'href="/payments/new/\?instalment=\d+"')
        self.assertRegex(html, r'href="/refunds/\d+/new/"')

    def test_one_click_switches_person_and_opens_the_step(self):
        review = self.review("Consent problem")
        tunde = self.member("Tunde Bello")
        response = self.client.post("/demo-role/", {"member": tunde.id, "next": f"/reviews/{review.id}/"}, follow=True)
        self.assertEqual(response.request["PATH_INFO"], f"/reviews/{review.id}/")
        self.assertIn('name="outcome"', response.content.decode())
        self.assertIn("You're now acting as Tunde Bello (Reviewer).", " ".join(self.messages_in(response)))

    def test_switching_never_leaves_the_site(self):
        tunde = self.member("Tunde Bello")
        for unsafe in ["https://example.com/", "//example.com/", "javascript:alert(1)", ""]:
            response = self.client.post("/demo-role/", {"member": tunde.id, "next": unsafe})
            self.assertRedirects(response, "/settings/", fetch_redirect_response=False, msg_prefix=repr(unsafe))

    def test_steps_that_need_another_person_offer_to_switch(self):
        self.act_as("Emeka Obi")
        page = read(self.client.get("/guide/").content.decode())
        buttons = ["".join(b).strip() for b in page.buttons]
        for label in ["Act as Ada Okafor and request a payment", "Act as Ada Okafor and request a refund", "Act as Tunde Bello and decide it"]:
            self.assertIn(label, buttons)
        self.act_as("Tunde Bello")
        buttons = ["".join(b).strip() for b in read(self.client.get("/guide/").content.decode()).buttons]
        self.assertNotIn("Act as Tunde Bello and decide it", buttons)

    def test_the_tour_works_end_to_end(self):
        """Follow steps 5 to 7 as a presenter would: request, decide as someone else, refund."""
        html = self.client.get("/guide/").content.decode()
        instalment = re.search(r'href="/payments/new/\?instalment=(\d+)"', html).group(1)
        self.client.post("/payments/new/", {"instalment": instalment, "amount": "100.00", "expiry_hours": 24, "confirmed": "1"})
        self.assertTrue(PaymentRequest.objects.filter(instalment_id=instalment, status="Awaiting approval").exists())
        review = self.review("Consent problem")
        self.client.post("/demo-role/", {"member": self.member("Tunde Bello").id, "next": f"/reviews/{review.id}/"})
        self.client.post(f"/reviews/{review.id}/", {"action": "resolve", "outcome": "Resolved", "note": "Customer re-authorised"})
        review.refresh_from_db()
        self.assertEqual(review.status, "Resolved")
        refund_url = re.search(r'href="(/refunds/\d+/new/)"', html).group(1)
        self.client.post("/demo-role/", {"member": self.member("Ada Okafor").id, "next": refund_url})
        self.client.post(refund_url, {"amount": "10.00", "reason": "Paid twice"})
        item = Review.objects.get(organisation=self.org, kind="Refund request")
        self.act_as("Tunde Bello")
        self.client.post(f"/reviews/{item.id}/", {"action": "resolve", "outcome": "Resolved", "note": "Checked"})
        self.assertEqual(Refund.objects.get(review=item).status, "Approved")

    def test_today_points_to_the_guide_until_it_is_opened(self):
        hint = "Open the demo guide"
        self.assertIn(hint, self.client.get("/").content.decode())
        self.client.get("/guide/")
        self.assertNotIn(hint, self.client.get("/").content.decode())
        self.client.post("/start/", {"restart": "1"})
        self.assertIn(hint, self.client.get("/").content.decode())

    def test_customer_pages_say_whose_view_it_is(self):
        loan = self.loan_of("Oluwaseun Adeyemi")
        self.client.post(f"/loans/{loan.id}/action/", {"action": "consent"})
        loan.refresh_from_db()
        self.assertIn("Demo · Customer's view · No real payments", Client().get(f"/consent/{loan.consent_token}/").content.decode())

    def test_hold_counts_say_how_many_loans(self):
        self.assertRegex(read(self.client.get("/").content.decode()).text(), r"Instalments on hold \d+ on 1 loan\b")
        self.assertRegex(read(self.client.get("/reports/").content.decode()).text(), r"Instalments on hold \d+ on 1 loan\b")

    def test_members_exist_for_the_guide(self):
        self.assertEqual(set(Member.objects.filter(organisation=self.org).values_list("name", flat=True)),
                         {"Ada Okafor", "Tunde Bello", "Zainab Yusuf", "Emeka Obi"})
