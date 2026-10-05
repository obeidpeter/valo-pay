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


# The ten steps in plain words (owner request: easy to follow while presenting). Each is
# (title, what the step shows, what to do on the page, sample role). Pages come from steps().
STEP_TEXT = [
    ("See what needs attention",
     "The Dashboard is the team's home screen. It shows what needs a decision and what is due today. "
     "Run today's sample debits to see how automatic collection works. It uses made-up data: no bank is contacted and no money moves.",
     "Point to the figures at the top. Then choose Run today's sample debits and read the Sample debit column.", "Admin"),
    ("Check a customer's repayments",
     "Each customer has one page with their loans, every instalment and what is still owed.",
     "Scroll to Instalments. Compare Amount, Paid and Outstanding.", "Preparer"),
    ("Understand an unclear payment result",
     "Sometimes we do not know yet if a payment went through. Valo Pay then puts the loan on hold, so the customer "
     "is not charged twice, until the bank or payment service confirms the result.",
     "Read Problem and evidence. The payment must not be requested again.", "Reviewer"),
    ("Ask for permission to collect payments",
     "Before money can be taken by direct debit, the customer must give permission at their bank. This is called consent. "
     "You create a link for the customer to give it.",
     "Under the loan's Actions, open Create consent link and choose Create consent link. Then choose Preview customer page.", "Preparer"),
    ("Create a payment request",
     "A payment request gives the customer a link to pay one instalment from their bank. Creating it sends nothing and moves no money.",
     "Choose the instalment. Keep the amount at or below what is owed, tick the box, then choose Create request link.", "Preparer"),
    ("Review another person's request",
     "Anything that affects money needs a second person. The person who prepared an item cannot decide it.",
     "Open an item. Under Decision, choose an outcome, add a decision note and choose Record decision.", "Reviewer"),
    ("Request a refund",
     "Refunds also need two people: one asks and another approves. Approving does not send money.",
     "Check the payment. Enter the refund amount and a reason, then choose Submit for approval.", "Preparer"),
    ("Add repayments from a spreadsheet",
     "A lender can add many repayments at once from a spreadsheet (a CSV file). If any row has a mistake, nothing is added.",
     "Choose Download CSV template. Put made-up rows in CSV data, then choose Validate rows.", "Preparer"),
    ("View and download reports",
     "Finance teams and auditors can download payments, consents, reviews and the activity log as spreadsheets.",
     "Point to the totals. Then open a download under CSV exports. Settings is in the sidebar under Organisation.", "Admin"),
    ("Explore planned features",
     "Credit Desk and Cash Desk are previews of what comes next. They do not work yet.",
     "Read Planned capabilities. Then choose Cash Desk under Coming later in the sidebar.", "Admin"),
]


def steps(org):
    loans = org.loan_set.order_by("reference")
    customer = loans.first()
    consent = loans.filter(consent_status="Not requested", status="Open").first()
    review = Review.objects.filter(organisation=org, kind="Unknown result").first()
    payment = Payment.objects.filter(organisation=org, status="Confirmed").first()
    paths = [
        "/today/",
        f"/customers/{customer.customer_id}/" if customer else "/customers/",
        f"/reviews/{review.pk}/" if review else "/reviews/",
        f"/customers/{consent.customer_id}/" if consent else "/customers/",
        "/payments/new/",
        "/reviews/",
        f"/refunds/{payment.pk}/new/" if payment else "/payments/",
        "/import/",
        "/reports/",
        "/credit/",
    ]
    people = {m.role: m.name for m in Member.objects.filter(organisation=org, user__isnull=True).order_by("-pk")}
    return [dict(number=n, title=t, description=d, hint=h, path=p, role=r, person=people.get(r, ""))
            for n, ((t, d, h, r), p) in enumerate(zip(STEP_TEXT, paths), 1)]


def guide(request):
    guard(request)
    if not available(request):
        return redirect("demo")
    c = context(request)
    from .content import GUIDE_STATE_HELP, STATE_LABEL
    return render(request, "demo_guide.html", {**c, "steps": steps(c["org"]), "title": "Demo guide", "page":"demo_guide",
                                             "state_explanations": [(STATE_LABEL.get(word, word), meaning) for word, meaning in GUIDE_STATE_HELP.items()]})


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
    total = len(STEP_TEXT)
    if type(number) is not int or not 1 <= number <= total or not available(request):
        return None
    title, _, hint, _ = STEP_TEXT[number - 1]
    return {"number": number, "total": total, "title": title, "hint": hint,
            "next": number + 1 if number < total else None, "previous": number - 1 if number > 1 else None}


@require_POST
def end_tour(request):
    guard(request)
    if not available(request):
        return redirect("demo")
    request.session.pop("demo_tour_step", None)
    return redirect("today")