from django.test import SimpleTestCase, override_settings


class LandingAvailabilityCopyTests(SimpleTestCase):
    def check_shared_copy(self, response):
        self.assertContains(response, "Demo requests are not open yet.", count=3)
        self.assertContains(response, 'href="/demo/">Explore the sample demo</a>', count=2)
        self.assertContains(response, 'href="/request-demo/">Request a demo</a>')
        for claim in ("We are working with early lenders", "Request a demo to discuss timing",
                      "Tell us about your organisation", "We will walk through"):
            self.assertNotContains(response, claim)

    @override_settings(SYNTHETIC_LEAD_TEST=False)
    def test_closed_enquiries_do_not_promise_collection_or_contact(self):
        response = self.client.get("/")
        self.check_shared_copy(response)
        self.assertContains(response, "Requests are not saved or sent.", count=2)
        self.assertContains(response, "No conversation is arranged.", count=2)
        self.assertNotContains(response, "Only sample requests can be saved")

    @override_settings(SYNTHETIC_LEAD_TEST=True)
    def test_test_acceptance_does_not_claim_public_enquiries_are_open(self):
        response = self.client.get("/")
        self.check_shared_copy(response)
        self.assertContains(response, "Only sample requests can be saved in this test mode.", count=2)
        self.assertContains(response, "No real messages are sent or conversations arranged.", count=2)
        self.assertNotContains(response, "Requests are not saved or sent.")