from django.test import TestCase
from .models import Organisation, Customer, Loan, Instalment, ImportPreview, Member
from .services import validate_csv


HEADER = "customer_id,name,email,phone,loan_id,product,amount,due_date\n"


class ImportGuidanceTests(TestCase):
    def setUp(self):
        self.org = Organisation.objects.create(name="Isolated import guidance synthetic")
        self.actor = Member.objects.create(organisation=self.org, name="Synthetic Admin", role="Admin")
        session = self.client.session
        session.update({"org": str(self.org.pk), "actor": self.actor.pk, "demo_mode": True})
        session.save()

    def row(self, amount="not-an-amount", due="2026-99-99", cid="QA-VISUAL-INVALID"):
        return f"{cid},Design QA Synthetic,qa@example.invalid,,{cid}-LOAN,Test,{amount},{due}\n"

    def test_both_fields_explain_corrections(self):
        errors, rows = validate_csv(HEADER + self.row(), self.org)
        self.assertEqual(len(errors), 2)
        self.assertIn("Row 2: amount:", errors[0])
        self.assertIn("example 18450.00", errors[0])
        self.assertIn("Row 2: due_date:", errors[1])
        self.assertIn("YYYY-MM-DD", errors[1])
        self.assertEqual(rows, [])
        self.assertNotIn("ConversionSyntax", str(errors))

    def test_invalid_numeric_and_date_variants(self):
        for value in ["", "NaN", "sNaN", "Infinity", "-1", "0", "1.234", "10000000000"]:
            with self.subTest(amount=value):
                errors, rows = validate_csv(HEADER + self.row(value, "2026-10-31"), self.org)
                self.assertIn("amount:", errors[0])
                self.assertEqual(rows, [])
        for value in ["", "2026-02-30", "20261031", "2026-99-99"]:
            with self.subTest(date=value):
                errors, rows = validate_csv(HEADER + self.row("18.50", value), self.org)
                self.assertIn("due_date:", errors[0])
                self.assertEqual(rows, [])

    def test_mixed_valid_invalid_import_cannot_save_partial_records(self):
        data = HEADER + self.row("18.50", "2026-10-31", "VALID") + self.row()
        for action in ("validate", "commit"):
            response = self.client.post("/import/", {"action": action, "csv_data": data})
            self.assertEqual(response.status_code, 200)
            self.assertContains(response, "Row 3: amount:")
            self.assertContains(response, "Row 3: due_date:")
            self.assertNotContains(response, "ConversionSyntax")
        self.assertEqual(Customer.objects.filter(organisation=self.org).count(), 0)
        self.assertEqual(Loan.objects.filter(organisation=self.org).count(), 0)
        self.assertEqual(Instalment.objects.filter(organisation=self.org).count(), 0)
        self.assertEqual(ImportPreview.objects.filter(organisation=self.org).count(), 0)