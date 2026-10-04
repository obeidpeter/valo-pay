"""The demo's own navigation: the start page, starting again and the demo guide."""
import re

from django.test import Client

from core import tour
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
    def go(self, step, **kwargs):
        return self.client.post("/guide/go/", {"step": step}, **kwargs)

    def acting_as(self):
        return Member.objects.get(pk=self.client.session["actor"]).name

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

    def test_every_step_opens_its_page_for_every_role(self):
        for name in ["Ada Okafor", "Tunde Bello", "Zainab Yusuf", "Emeka Obi"]:
            for step in range(1, len(tour.STEPS) + 1):
                self.act_as(name)
                where = f"step {step} as {name}"
                response = self.go(step, follow=True)
                self.assertEqual(response.status_code, 200, where)
                self.assertTemplateNotUsed(response, "start.html", where)
                self.check(response, where)
                self.assertEqual(self.acting_as(), tour.STEPS[step - 1]["person"] or name, where)

    def test_steps_open_the_sample_records(self):
        customer = lambda name: f"/customers/{self.loan_of(name).customer_id}/"
        problem = f"/reviews/{self.review('Consent problem').id}/"
        expected = {1: "/", 2: customer("Chidi Nwosu"), 3: customer("Amara Okeke"), 4: customer("Oluwaseun Adeyemi"),
                    6: problem, 7: problem, 9: "/reviews/", 10: "/reports/", 11: "/credit/"}
        for step, url in expected.items():
            self.assertRedirects(self.go(step), url, fetch_redirect_response=False, msg_prefix=f"step {step}")
        self.assertRegex(self.go(5)["Location"], r"^/payments/new/\?instalment=\d+$")
        self.assertRegex(self.go(8)["Location"], r"^/refunds/\d+/new/$")

    def test_a_step_switches_to_the_person_it_names(self):
        self.act_as("Emeka Obi")
        response = self.go(7, follow=True)
        self.assertEqual(response.request["PATH_INFO"], f"/reviews/{self.review('Consent problem').id}/")
        self.assertIn('name="outcome"', response.content.decode())
        self.assertIn("You're now acting as Tunde Bello (Reviewer).", " ".join(self.messages_in(response)))
        response = self.go(6, follow=True)
        self.assertEqual(self.acting_as(), "Ada Okafor")
        self.assertIn("You prepared this item, so a different person must decide it.", read(response.content.decode()).text())
        # A step that names nobody keeps the current person and says nothing about switching.
        response = self.go(1, follow=True)
        self.assertEqual(self.acting_as(), "Ada Okafor")
        self.assertNotIn("acting as", " ".join(self.messages_in(response)))

    def test_import_offers_to_switch_when_needed(self):
        self.act_as("Emeka Obi")
        buttons = ["".join(b).strip() for b in read(self.client.get("/guide/").content.decode()).buttons]
        self.assertIn("Act as Ada Okafor and open Import", buttons)

    def test_one_click_switches_person_and_opens_a_page(self):
        review = self.review("Consent problem")
        tunde = self.member("Tunde Bello")
        response = self.client.post("/demo-role/", {"member": tunde.id, "next": f"/reviews/{review.id}/"}, follow=True)
        self.assertEqual(response.request["PATH_INFO"], f"/reviews/{review.id}/")
        self.assertIn("You're now acting as Tunde Bello (Reviewer).", " ".join(self.messages_in(response)))

    def test_switching_never_leaves_the_site(self):
        tunde = self.member("Tunde Bello")
        for unsafe in ["https://example.com/", "//example.com/", "javascript:alert(1)", ""]:
            response = self.client.post("/demo-role/", {"member": tunde.id, "next": unsafe})
            self.assertRedirects(response, "/settings/", fetch_redirect_response=False, msg_prefix=repr(unsafe))

    def test_steps_are_opened_only_by_a_form_and_must_exist(self):
        self.assertEqual(self.client.get("/guide/go/?step=1").status_code, 405)
        self.assertEqual(self.client.get("/guide/end/").status_code, 405)
        for bad in ["0", str(len(tour.STEPS) + 1), "-1", "1.5", "x", ""]:
            self.assertEqual(self.go(bad).status_code, 404, repr(bad))
        self.assertNotIn("guide_step", self.client.session)
        self.assertEqual(Client(enforce_csrf_checks=True).post("/guide/go/", {"step": 1}).status_code, 403)

    def test_the_step_bar_follows_the_tour(self):
        self.assertNotIn('class="tourbar"', self.client.get("/").content.decode())
        self.go(4)
        response = self.client.get("/customers/")
        text, html = self.check(response, "a page with the step bar"), response.content.decode()
        for words in [f"Step 4 of {len(tour.STEPS)} · As Ada Okafor", tour.STEPS[3]["title"], tour.STEPS[3]["hint"]]:
            self.assertIn(words, text)
        self.assertIn('href="/guide/#step-4"', html)
        self.assertIn('name="step" value="5"><button class="btn sm" type="submit">Next step</button>', html)
        guide = self.client.get("/guide/").content.decode()
        self.assertNotIn('class="tourbar"', guide)
        self.assertIn('<li id="step-4" class="now">', guide)
        self.assertIn("Continue the tour", guide)
        self.go(len(tour.STEPS))
        buttons = ["".join(b).strip() for b in read(self.client.get("/").content.decode()).buttons]
        self.assertIn("End tour", buttons)
        self.assertNotIn("Next step", buttons)
        self.assertRedirects(self.client.post("/guide/end/"), "/guide/", fetch_redirect_response=False)
        self.assertNotIn('class="tourbar"', self.client.get("/").content.decode())

    def test_starting_again_ends_the_tour(self):
        self.go(3)
        self.client.post("/start/", {"restart": "1"})
        self.assertNotIn('class="tourbar"', self.client.get("/").content.decode())

    def test_approving_opens_the_newest_refund_request(self):
        """A refund requested while rehearsing must not be the one step 9 opens during the demo."""
        refund_url = self.go(8)["Location"]
        for reason in ["Paid twice", "Customer overpaid"]:
            self.client.post(refund_url, {"amount": "10.00", "reason": reason})
        requests = Review.objects.filter(organisation=self.org, kind="Refund request")
        self.assertEqual(requests.count(), 2)
        self.assertEqual(self.go(9)["Location"], f"/reviews/{requests.latest('id').id}/")

    def test_the_tour_works_end_to_end(self):
        """Follow steps 5 to 9 as a presenter would: request a payment, decide as someone else, refund."""
        instalment = re.search(r"instalment=(\d+)", self.go(5)["Location"]).group(1)
        self.client.post("/payments/new/", {"instalment": instalment, "amount": "100.00", "expiry_hours": 24, "confirmed": "1"})
        self.assertTrue(PaymentRequest.objects.filter(instalment_id=instalment, status="Awaiting approval").exists())
        review = self.review("Consent problem")
        self.assertEqual(self.go(7)["Location"], f"/reviews/{review.id}/")
        self.client.post(f"/reviews/{review.id}/", {"action": "resolve", "outcome": "Resolved", "note": "Customer re-authorised"})
        review.refresh_from_db()
        self.assertEqual((review.status, review.resolved_by.name), ("Resolved", "Tunde Bello"))
        self.client.post(self.go(8)["Location"], {"amount": "10.00", "reason": "Paid twice"})
        item = Review.objects.get(organisation=self.org, kind="Refund request")
        self.assertEqual(item.prepared_by.name, "Ada Okafor")
        self.assertEqual(self.go(9)["Location"], f"/reviews/{item.id}/")
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
