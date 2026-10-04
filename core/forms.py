from decimal import Decimal
from django import forms
from .models import Organisation, Instalment

AMOUNT_ERRORS = {
    "required": "Enter an amount in naira, for example 18450.00.",
    "invalid": "Enter the amount as a number, for example 18450.00.",
    "min_value": "Enter an amount of at least ₦0.01.",
    "max_decimal_places": "Enter the amount with no more than 2 decimal places, for example 18450.50.",
    "max_whole_digits": "Enter an amount below ₦10,000,000,000.",
    "max_digits": "Enter an amount below ₦10,000,000,000.",
}


class PlainForm(forms.Form):
    # Labels read as labels, without Django's trailing colon.
    def __init__(self, *args, **kwargs):
        kwargs.setdefault("label_suffix", "")
        super().__init__(*args, **kwargs)


class CustomerForm(PlainForm):
    name = forms.CharField(label="Customer name", max_length=120, error_messages={"required": "Enter the customer's name."})
    external_id = forms.CharField(label="Customer ID", max_length=60, help_text="Your organisation's ID for this customer.",
                                  error_messages={"required": "Enter the customer ID."})
    email = forms.EmailField(label="Email (optional)", required=False, error_messages={"invalid": "Enter an email address such as name@example.com."})
    phone = forms.CharField(label="Phone (optional)", max_length=30, required=False)
    loan_id = forms.CharField(label="Loan ID", max_length=60, help_text="Your organisation's ID for this loan.",
                              error_messages={"required": "Enter the loan ID."})
    product = forms.CharField(label="Loan product", max_length=80, initial="Personal finance", help_text="For example, Asset finance.",
                              error_messages={"required": "Enter the loan product."})
    amount = forms.DecimalField(label="Amount of each instalment (₦)", max_digits=12, decimal_places=2, min_value=Decimal("0.01"),
                                help_text="For example, 18450.00.", error_messages=AMOUNT_ERRORS)
    due_date = forms.DateField(label="First due date", input_formats=["%Y-%m-%d"], widget=forms.DateInput(attrs={"type": "date"}),
                               help_text="Later instalments fall on the same day of each following month, or on the last day of a shorter month.",
                               error_messages={"required": "Enter the first due date.", "invalid": "Enter the date as YYYY-MM-DD, for example 2026-11-15."})
    instalment_count = forms.IntegerField(label="Number of instalments", min_value=1, max_value=120, initial=6, help_text="From 1 to 120, one each month.",
                                          error_messages={key: "Enter a whole number from 1 to 120." for key in ["required", "invalid", "min_value", "max_value"]})


class InstalmentChoice(forms.ModelChoiceField):
    def label_from_instance(self, i):
        label = f"{i.loan.customer.name} · {i.loan.reference} · instalment {i.sequence} · {i.outstanding_display} outstanding"
        return f"{label} · on hold" if i.loan.on_hold else label


class RequestForm(PlainForm):
    instalment = InstalmentChoice(queryset=Instalment.objects.none(), empty_label="Choose an instalment",
                                  error_messages={"required": "Choose the instalment this payment is for.",
                                                  "invalid_choice": "Choose an instalment from the list. Paid instalments and closed loans are not listed."})
    amount = forms.DecimalField(label="Amount (₦)", max_digits=12, decimal_places=2, min_value=Decimal("0.01"),
                                help_text="Up to the amount outstanding on the instalment.", error_messages=AMOUNT_ERRORS)
    expiry_hours = forms.IntegerField(label="Link expires after (hours)", min_value=1, max_value=168, initial=24, help_text="From 1 hour to 168 hours (7 days).",
                                      error_messages={key: "Enter a number of hours from 1 to 168." for key in ["required", "invalid", "min_value", "max_value"]})
    def __init__(self, *args, org, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["instalment"].queryset = Instalment.objects.filter(organisation=org, loan__status="Open").select_related("loan__customer").exclude(state="Paid")


class RefundForm(PlainForm):
    amount = forms.DecimalField(label="Refund amount (₦)", max_digits=12, decimal_places=2, min_value=Decimal("0.01"),
                                error_messages={**AMOUNT_ERRORS, "required": "Enter the amount to refund."})
    reason = forms.CharField(label="Reason for the refund", max_length=1500, widget=forms.Textarea,
                             help_text="The person who reviews the request sees this. It is saved with the request.",
                             error_messages={"required": "Enter the reason for this refund."})


class SettingsForm(forms.ModelForm):
    retry_preset = forms.ChoiceField(label="Retry preset", choices=[("Standard", "Standard · try again after 2 and 5 days"), ("Gentle", "Gentle · try once more after 3 days"), ("Off", "Off · do not try again")],
                                     help_text="What happens when a direct debit does not go through. Customers see this on the consent page.")
    def __init__(self, *args, **kwargs):
        kwargs.setdefault("label_suffix", "")
        super().__init__(*args, **kwargs)
    class Meta:
        model = Organisation
        fields = ["name", "retry_preset", "receipts"]
        labels = {"name": "Organisation name", "receipts": "Email receipts to customers"}
        help_texts = {"name": "Customers see this name on consent and payment pages.",
                      "receipts": "When this is on, customers get an email receipt for each confirmed payment. Emails are not sent in this demo."}
        error_messages = {"name": {"required": "Enter your organisation's name."}}
