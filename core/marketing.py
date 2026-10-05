from django import forms
from django.shortcuts import render, redirect
from django.views.decorators.http import require_POST
from django.conf import settings
from django.db import transaction
from django.utils.crypto import salted_hmac
from .models import DemoLead


class DemoForm(forms.Form):
    name = forms.CharField(max_length=120)
    email = forms.EmailField(label="Work email")
    organisation = forms.CharField(max_length=120)
    organisation_type = forms.ChoiceField(choices=[("lender", "Lender"), ("cooperative", "Cooperative"), ("other", "Other")])
    notes = forms.CharField(required=False, max_length=1500, widget=forms.Textarea)


def landing(request):
    return render(request, "landing.html", {
        "synthetic_lead_test": bool(getattr(settings, "SYNTHETIC_LEAD_TEST", False)),
    })


def demo(request):
    from .demo_flow import start_page
    return start_page(request)


def lead(request):
    form = DemoForm(request.POST or None)
    accepted = False
    if request.method == "POST":
        valid = form.is_valid()
        # Only isolated test settings may accept synthetic example.invalid leads.
        if not getattr(settings, "SYNTHETIC_LEAD_TEST", False):
            form.add_error(None, "Public collection is disabled until an approved privacy notice is configured. Nothing was saved or sent.")
        elif valid:
            d = form.cleaned_data
            if not d["email"].lower().endswith("@example.invalid"):
                form.add_error("email", "Use a synthetic example.invalid address.")
            else:
                digest = salted_hmac("lead", d["email"].lower() + "|" + d["organisation"].casefold()).hexdigest()
                with transaction.atomic():
                    DemoLead.objects.get_or_create(fingerprint=digest, defaults={
                        "name": d["name"], "email": d["email"].lower(), "organisation_name": d["organisation"],
                        "organisation_type": d["organisation_type"], "notes": d["notes"]})
                accepted = True
    return render(request, "lead_form.html", {"form": form, "accepted": accepted, "privacy_available": False})