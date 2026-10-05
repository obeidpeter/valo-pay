"""Explicit synthetic-only entry; no schema changes or deletion of retained data."""
import time
from django.core.exceptions import PermissionDenied
from django.db import transaction
from django.shortcuts import render, redirect
from django.views.decorators.http import require_POST
from .models import Organisation, Member, Loan, Review, Payment, StaffMembership
from .services import seed_demo, context


def available(request):
    if request.user.is_authenticated:
        return False
    oid = request.session.get("org")
    return bool(oid and request.session.get("demo_flow_org") == oid
        and request.session.get("demo_mode")
        and time.time() - request.session.get("demo_idle_at", 0) < 1800
        and Organisation.objects.filter(pk=oid).exists()
        and not StaffMembership.objects.filter(organisation_id=oid).exists()
        and not Member.objects.filter(organisation_id=oid, user__isnull=False).exists())


def guard(request):
    if request.user.is_authenticated:
        raise PermissionDenied("Staff must sign out before using a separate synthetic demo.")


def start_page(request):
    guard(request)
    return render(request, "demo_start.html", {"demo_available": available(request)})


@require_POST
@transaction.atomic
def start(request):
    guard(request)
    if available(request):
        return redirect("today")
    org, actor = seed_demo()
    request.session.cycle_key()
    request.session.update({"org": str(org.pk), "actor": actor.pk, "demo_mode": True,
                            "demo_flow_org": str(org.pk), "demo_idle_at": time.time()})
    return redirect("demo_guide")


def restart(request):
    guard(request)
    if request.method == "POST":
        if request.POST.get("confirm") != "yes" or not available(request):
            raise PermissionDenied("Confirm replacement from an active synthetic demo.")
        # Detach only. No old organisation, financial or audit record is deleted.
        for key in ("org", "actor", "demo_mode", "demo_flow_org", "demo_idle_at", "demo_tour_step"):
            request.session.pop(key, None)
        return start(request)
    return render(request, "demo_start.html", {"demo_available": available(request),
                                             "restart_confirm": True})


def steps(org):
    loans = org.loan_set.order_by("reference")
    customer = loans.first()
    consent = loans.filter(consent_status="Not requested", status="Open").first()
    review = Review.objects.filter(organisation=org, kind="Unknown result").first()
    payment = Payment.objects.filter(organisation=org, status="Confirmed").first()
    entries = [
        ("See what needs attention", "On the Dashboard, look at ‘Needs a decision’ and ‘Due today’. Choose ‘Run today's sample debits’ to simulate eligible payments. Paid and failed outcomes are made up; blocked items show why they cannot run. Running again does not repeat paid or failed attempts. No real money moves and no retries are scheduled.", "/today/", "Admin"),
        ("Check a customer's repayments", "If Customers opens, choose a name. Under each loan, read ‘Instalments’ — the separate repayments due. ‘Outstanding’ is the amount still owed; compare it with ‘Amount’ and ‘Paid’.", f"/customers/{customer.customer_id}/" if customer else "/customers/", "Preparer"),
        ("Understand an unclear payment result", "If Reviews opens, choose an item, then read ‘Problem and evidence’ and ‘Decision’. Unknown is not Failed: collection stays on hold until there is a verified result from the bank or payment service. Do not request payment again. If the review is closed or its decision is blocked, read the reason and move on.", f"/reviews/{review.pk}/" if review else "/reviews/", "Reviewer"),
        ("Ask for permission to collect payments", "Consent means permission; if Customers opens, choose a name first. Under a loan’s ‘Actions’, open ‘Create consent link’ and choose the button with the same name, then ‘Preview customer page’. This creates a sample link only and does not contact a bank. The action may be unavailable for some records; read the reason and continue.", f"/customers/{consent.customer_id}/" if consent else "/customers/", "Preparer"),
        ("Create a payment request", "On New payment request, choose ‘Instalment’ and fill in ‘Amount (₦)’ and ‘Link expires after (hours)’. Keep the amount at or below what is still owed. Read and tick the checkbox, then choose ‘Create request link’ if the record allows it. This creates a sample link, not a payment.", "/payments/new/", "Preparer"),
        ("Review another person's request", "On Reviews, open an item and read ‘Problem and evidence’. Under ‘Decision’, if a decision is available, choose an outcome, add a ‘Decision note’ and select ‘Record decision’. The person who prepared the request cannot approve it. If a decision is blocked, read the reason and continue.", "/reviews/", "Reviewer"),
        ("Request a refund", "If Pay-by-bank opens, look for a Confirmed payment with ‘Request refund’, if available. On Request a refund, check the payment, then enter ‘Refund amount (₦)’ and ‘Reason’. Choose ‘Submit for approval’ to ask another person to review it. Approval does not send a refund.", f"/refunds/{payment.pk}/new/" if payment else "/payments/", "Preparer"),
        ("Add repayments from a spreadsheet", "Choose ‘Download CSV template’ — CSV is a spreadsheet file — and fill it with made-up data only. Add it using ‘CSV file (optional)’ or paste it into ‘CSV data’, then choose ‘Validate rows’. Check every row and fix any errors before confirming with ‘Import … rows’. If any row has an error, nothing is imported.", "/import/", "Preparer"),
        ("View and download reports", "On Reports, read the totals and open a download under ‘CSV exports’. Each export includes matching records for this sample organisation, including rows beyond those on screen. For team and setup information, you can also open the Account menu and choose ‘Settings’.", "/reports/", "Admin"),
        ("Explore planned features", "Start at Credit Desk and read ‘Planned capabilities’. Open the Account menu and choose ‘Cash Desk’ to see the other preview. Both describe planned services; neither is available to use. Return to the Dashboard when you finish.", "/credit/", "Admin"),
    ]
    return [dict(number=n, title=t, description=d, path=p, role=r) for n,(t,d,p,r) in enumerate(entries,1)]


def guide(request):
    guard(request)
    if not available(request):
        return redirect("demo")
    c = context(request)
    from .content import GUIDE_STATE_HELP
    return render(request, "demo_guide.html", {**c, "steps": steps(c["org"]), "title": "Demo guide", "page":"demo_guide",
                                             "state_explanations": GUIDE_STATE_HELP.items()})


@require_POST
def action(request):
    guard(request)
    if not available(request):
        return redirect("demo")
    c = context(request)
    selected = next((s for s in steps(c["org"]) if str(s["number"]) == request.POST.get("step")), None)
    if selected is None:
        raise PermissionDenied("Choose a listed demo step.")
    member = Member.objects.filter(organisation=c["org"], role=selected["role"], user__isnull=True).first()
    if not member:
        raise PermissionDenied("This sample role is unavailable.")
    request.session["actor"] = member.pk
    request.session["demo_tour_step"] = selected["number"]
    # Destinations are generated here; never accept a caller-supplied next URL.
    return redirect(selected["path"])


def tour_bar(request):
    number = request.session.get("demo_tour_step")
    if type(number) is not int or not 1 <= number <= 10 or not available(request):
        return None
    return {"number": number, "total": 10, "next": number + 1 if number < 10 else None,
            "previous": number - 1 if number > 1 else None}


@require_POST
def end_tour(request):
    guard(request)
    if not available(request):
        return redirect("demo")
    request.session.pop("demo_tour_step", None)
    return redirect("today")