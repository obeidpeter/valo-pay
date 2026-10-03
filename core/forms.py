from django import forms
from .models import Organisation, Instalment


class CustomerForm(forms.Form):
    name = forms.CharField(max_length=120)
    external_id = forms.CharField(label="Customer ID", max_length=60)
    email = forms.EmailField(required=False)
    phone = forms.CharField(max_length=30, required=False)
    loan_id = forms.CharField(max_length=60)
    product = forms.CharField(max_length=80, initial="Personal finance")
    amount = forms.DecimalField(label="Instalment amount (₦)", max_digits=12, decimal_places=2, min_value=0.01)
    due_date = forms.DateField(widget=forms.DateInput(attrs={"type": "date"}))
    instalment_count = forms.IntegerField(min_value=1, max_value=120, initial=6)


class RequestForm(forms.Form):
    instalment = forms.ModelChoiceField(queryset=Instalment.objects.none())
    amount = forms.DecimalField(label="Amount (₦)", max_digits=12, decimal_places=2, min_value=0.01)
    expiry_hours = forms.IntegerField(min_value=1, max_value=168, initial=24)
    def __init__(self, *args, org, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["instalment"].queryset = Instalment.objects.filter(organisation=org, loan__status="Open").select_related("loan__customer").exclude(state="Paid")


class RefundForm(forms.Form):
    amount = forms.DecimalField(label="Refund amount (₦)", max_digits=12, decimal_places=2, min_value=0.01)
    reason = forms.CharField(max_length=1500, widget=forms.Textarea)


class SettingsForm(forms.ModelForm):
    retry_preset = forms.ChoiceField(choices=[("Standard", "Standard · retry after 2 and 5 days"), ("Gentle", "Gentle · once after 3 days"), ("Off", "Off · no retries")])
    class Meta:
        model = Organisation
        fields = ["name", "retry_preset", "receipts"]