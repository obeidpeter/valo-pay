import re
from core.models import Customer, Review
from .base import WorkspaceTestCase


class NavigationTests(WorkspaceTestCase):
    def test_every_internal_link_resolves(self):
        customer = Customer.objects.filter(organisation=self.org).first()
        review = Review.objects.filter(organisation=self.org).first()
        pages = ["/", "/customers/", f"/customers/{customer.id}/", f"/customers/{customer.id}/edit/", "/import/",
                 "/collections/", "/payments/", "/payments/new/", "/reviews/", f"/reviews/{review.id}/",
                 "/reports/", "/settings/", "/credit/", "/cash/"]
        links = set()
        for url in pages:
            response = self.client.get(url)
            self.assertEqual(response.status_code, 200, url)
            links |= {(url, href) for href in re.findall(r'href="(/[^"#]*)', response.content.decode())}
        for source, href in sorted(links):
            self.assertLess(self.client.get(href).status_code, 400, f"{href} linked from {source}")

    def test_preview_links_are_highlighted(self):
        self.assertContains(self.client.get("/credit/"), '<a href="/credit/" class="on">')
        self.assertContains(self.client.get("/cash/"), '<a href="/cash/" class="on">')
