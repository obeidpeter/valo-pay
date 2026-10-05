"""The demo guide's tour: twelve steps through the sample lender, and the bar that walks a presenter through them.

Each step opens one page, as the person it names, so a presenter can choose Next step and keep talking. The page
is worked out when the step is opened, because some records exist only after an earlier step: the refund request
in step 10 comes from step 9. If a sample record was changed or deleted, the step opens its list page instead.
"""
from django.http import Http404

from .models import Customer, Instalment, Member, Payment, PaymentRequest, Review

ADA, TUNDE = "Ada Okafor", "Tunde Bello"
OPEN = ["Open", "In progress"]

STEPS = [
    {"page": "today", "person": None, "label": "Open the Dashboard", "title": "See today's work",
     "text": "The Dashboard is the team's home screen. It shows what is due, what failed, what is on hold and what needs a decision.",
     "hint": "Point to the figures at the top, then to Due today and Needs a decision."},
    {"page": "due today", "person": ADA, "label": "Open Due today", "title": "Run today's direct debits",
     "text": "In the live service, Valo Pay debits every instalment due today by itself each morning, but only where consent is "
             "active and the loan is not on hold. Here you start the run yourself, on sample data. No bank is contacted.",
     "hint": "Choose Run today's debits. Then point to the Debit column: collected, failed with a next try, or not debited and why."},
    {"page": "CUS-1002", "person": None, "label": "Open Chidi Nwosu", "title": "Open a customer's record",
     "text": "Each customer has one page: the loan, the consent, every instalment, every payment and an audit trail of who did what.",
     "hint": "Scroll down to show the instalments and the audit trail."},
    {"page": "CUS-1001", "person": None, "label": "Open Amara Okeke", "title": "See a safeguard",
     "text": "One of Amara Okeke's payments has no final result yet. Valo Pay keeps the loan on hold, so no new payment "
             "can be requested until the result is known. A person checks it in Reviews.",
     "hint": "Point to the On hold note."},
    {"page": "CUS-1004", "person": ADA, "label": "Open Oluwaseun Adeyemi", "title": "Ask a customer for consent",
     "text": "Before the lender can collect by direct debit, the customer must give consent at their bank. You send a "
             "consent link and can preview what the customer sees. The bank step is not connected in this demo.",
     "hint": "Under Loan actions, open Create a consent link and choose Create consent link. Then choose Preview."},
    {"page": "request", "person": ADA, "label": "Request a payment from Chidi Nwosu", "title": "Request a payment by bank",
     "text": "Pay-by-bank sends the customer a link to pay one instalment from their bank. Creating the request sends "
             "nothing and moves no money.",
     "hint": "Tick the box and choose Create payment request. Then choose Preview the customer's page."},
    {"page": "consent problem", "person": ADA, "label": "Open the consent problem", "title": "See why Ada cannot decide",
     "text": "Ada Okafor prepared this consent problem, so Valo Pay does not let Ada decide it. A second person must.",
     "hint": "Point to the line that says a different person must decide it."},
    {"page": "consent problem", "person": TUNDE, "label": "Decide it as Tunde Bello", "title": "Decide as a second person",
     "text": "Tunde Bello, the Reviewer, records the decision with a note. Valo Pay saves who decided and why.",
     "hint": "Leave Resolve selected, add a short note, then choose Record decision."},
    {"page": "refund", "person": ADA, "label": "Request a refund", "title": "Request a refund",
     "text": "Refunds also need two people. Ada Okafor asks for a refund on one of Chidi Nwosu's payments.",
     "hint": "Enter an amount and a reason, then choose Request refund."},
    {"page": "refund request", "person": TUNDE, "label": "Approve it as Tunde Bello", "title": "Approve the refund",
     "text": "Tunde Bello approves the refund. It then shows as Approved, not refunded yet: in the live service, "
             "Paystack processes the refund.",
     "hint": "Leave Approve refund selected, add a short note, then choose Record decision."},
    {"page": "reports", "person": None, "label": "Open Reports", "title": "Check reports and settings",
     "text": "Reports has CSV downloads for reconciliation and audit. Settings shows the four roles, a price example and "
             "the checklist to finish before live payments are switched on.",
     "hint": "Show the CSV downloads. Then choose Settings & team in the sidebar.", "links": [("Open Settings", "/settings/")]},
    {"page": "credit", "person": None, "label": "Open Credit Desk", "title": "See what comes next",
     "text": "Credit Desk and Cash Desk are previews of workspaces planned for later. They do not work yet.",
     "hint": "Show the Credit Desk preview. Then choose Cash Desk in the sidebar.", "links": [("Open Cash Desk", "/cash/")]},
]
FIXED = {"today": "/", "due today": "/#due-today", "reports": "/reports/", "credit": "/credit/"}


def number(value):
    """The step number sent by a form; anything other than 1 to len(STEPS) is a 404."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise Http404("No such step.")
    if not 1 <= n <= len(STEPS):
        raise Http404("No such step.")
    return n


def person(org, n):
    """The team member step n is shown as, or None when anyone will do."""
    name = STEPS[n - 1]["person"]
    return Member.objects.filter(organisation=org, name=name).first() if name else None


def bar(n):
    """What the step bar on staff pages shows while a tour is running, or None when no tour is running."""
    if not isinstance(n, int) or not 1 <= n <= len(STEPS):
        return None
    step = STEPS[n - 1]
    return {"number": n, "total": len(STEPS), "title": step["title"], "hint": step["hint"], "person": step["person"],
            "next": n + 1 if n < len(STEPS) else None}


def target(org, n):
    """The page step n opens, found now from the workspace's own records."""
    page = STEPS[n - 1]["page"]
    if page in FIXED:
        return FIXED[page]
    if page.startswith("CUS-"):
        customer = Customer.objects.filter(organisation=org, external_id=page).first()
        return f"/customers/{customer.id}/" if customer else "/customers/"
    chidi = Customer.objects.filter(organisation=org, external_id="CUS-1002").first()
    if page == "request":
        # The first instalment of Chidi's that can take a new request: not paid, not on hold, no request in progress.
        busy = set(PaymentRequest.objects.filter(organisation=org, status__in=["Awaiting approval", "Awaiting confirmation", "Unknown"])
                   .values_list("instalment_id", flat=True))
        instalments = Instalment.objects.filter(loan__customer=chidi, loan__status="Open", loan__on_hold=False).select_related("loan").order_by("loan_id", "sequence") if chidi else []
        found = next((i for i in instalments if i.requestable and i.id not in busy), None)
        return f"/payments/new/?instalment={found.id}" if found else "/collections/"
    if page == "refund":
        payment = Payment.objects.filter(organisation=org, status="Confirmed", instalment__loan__customer=chidi).first() if chidi else None
        return f"/refunds/{payment.id}/new/" if payment else "/payments/"
    if page == "consent problem":
        problems = Review.objects.filter(organisation=org, kind="Consent problem")
        review = problems.filter(status__in=OPEN).first() or problems.order_by("-id").first()
        return f"/reviews/{review.id}/" if review else "/reviews/"
    # "refund request": the newest one still waiting for a decision, which step 8 creates.
    review = Review.objects.filter(organisation=org, kind="Refund request", status__in=OPEN).order_by("-id").first()
    return f"/reviews/{review.id}/" if review else "/reviews/"
