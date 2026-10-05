from django import forms
from decimal import Decimal
from .models import Organisation, Instalment


class CustomerForm(forms.Form):
    name = forms.CharField(max_length=120)
    external_id = forms.CharField(label="Customer ID", max_length=60)
    email = forms.EmailField(required=False)
    phone = forms.CharField(max_length=30, required=False)
    loan_id = forms.CharField(max_length=60)
    product = forms.CharField(max_length=80, initial="Personal finance")
    amount = forms.DecimalField(label="Instalment amount (₦)", max_digits=12, decimal_places=2, min_value=Decimal("0.01"),
        help_text="Use naira and kobo with at most two decimal places, for example 18450.00.")
    due_date = forms.DateField(label="First due date", input_formats=["%Y-%m-%d"], widget=forms.DateInput(attrs={"type": "date"}),
        help_text="Later instalments fall on the same day of each following month, or the last day of a shorter month.",
        error_messages={"invalid":"Enter the date as YYYY-MM-DD, for example 2026-11-15."})
    instalment_count = forms.IntegerField(min_value=1, max_value=120, initial=6)


class InstalmentChoice(forms.ModelChoiceField):
    def label_from_instance(self, item):
        return f"{item.loan.customer.name} · {item.loan.reference} · instalment {item.sequence} · {item.outstanding_display} outstanding"


class RequestForm(forms.Form):
    instalment = InstalmentChoice(queryset=Instalment.objects.none(), empty_label="Choose an instalment")
    amount = forms.DecimalField(label="Amount (₦)", max_digits=12, decimal_places=2, min_value=Decimal("0.01"),
        help_text="Up to the outstanding balance of this instalment.")
    expiry_hours = forms.IntegerField(label="Link expires after (hours)", min_value=1, max_value=168, initial=24,
        help_text="From 1 hour to 168 hours (7 days).")
    def __init__(self, *args, org, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["instalment"].queryset = Instalment.objects.filter(organisation=org, loan__status="Open").select_related("loan__customer").exclude(state="Paid")


class RefundForm(forms.Form):
    amount = forms.DecimalField(label="Refund amount (₦)", max_digits=12, decimal_places=2, min_value=Decimal("0.01"))
    reason = forms.CharField(max_length=1500, widget=forms.Textarea)


class SettingsForm(forms.ModelForm):
    retry_preset = forms.ChoiceField(choices=[("Standard", "Standard · retry after 2 and 5 days"), ("Gentle", "Gentle · once after 3 days"), ("Off", "Off · no retries")])
    class Meta:
        model = Organisation
        fields = ["name", "retry_preset", "receipts"]