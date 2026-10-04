from django.test import TestCase
from core.models import Organisation, Member, Loan, Review


class WorkspaceTestCase(TestCase):
    """Opens a demo workspace through the start page, as a visitor would, and acts as Ada (Admin)."""

    def setUp(self):
        self.client.post("/start/")
        self.org = Organisation.objects.get(pk=self.client.session["org"])

    def member(self, name):
        return Member.objects.get(organisation=self.org, name=name)

    def act_as(self, name):
        self.client.post("/demo-role/", {"member": self.member(name).id})

    def loan_of(self, customer_name):
        return Loan.objects.get(organisation=self.org, customer__name=customer_name)

    def review(self, kind):
        return Review.objects.filter(organisation=self.org, kind=kind).latest("id")

    def messages_in(self, response):
        return [str(m) for m in response.context["messages"]]

    def import_csv(self, rows):
        text = "customer_id,name,email,phone,loan_id,product,amount,due_date\n" + "\n".join(rows) + "\n"
        return self.client.post("/import/", {"csv_data": text, "action": "commit"}, follow=True)
