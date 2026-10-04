import csv
import hashlib
import io
import calendar
from datetime import timedelta, date
from decimal import Decimal, InvalidOperation
from importlib import import_module
from django.conf import settings
from django.db import transaction
from django.utils import timezone
from .models import Organisation, Member, Customer, Loan, Instalment, Payment, Review, Audit, PaymentRequest, Refund

# Delete order for a workspace: each model before the rows it protects (on_delete=PROTECT).
PURGE_ORDER = [Refund, Review, PaymentRequest, Payment, Instalment, Loan, Customer, Audit, Member]


class WorkspaceRequired(Exception):
    """The session has no live demo workspace; WorkspaceMiddleware sends the visitor to the start page."""


def audit(org, actor, action, detail):
    # Lock the tenant while appending, so concurrent writes cannot fork the chain.
    Organisation.objects.select_for_update().get(pk=org.pk)
    prev = Audit.objects.filter(organisation=org).first()
    previous = prev.digest if prev else ""
    name = actor.name if actor else "System"
    digest = hashlib.sha256(f"{previous}|{name}|{action}|{detail}".encode()).hexdigest()
    Audit.objects.create(organisation=org, actor_name=name, action=action, detail=detail, previous_hash=previous, digest=digest)


def month_date(start, offset):
    month = start.month - 1 + offset
    year = start.year + month // 12
    month = month % 12 + 1
    return date(year, month, min(start.day, calendar.monthrange(year, month)[1]))


@transaction.atomic
def seed_demo():
    org = Organisation.objects.create(demo=True)
    prep = Member.objects.create(organisation=org, name="Ada Okafor", role="Admin")
    reviewer = Member.objects.create(organisation=org, name="Tunde Bello", role="Reviewer")
    Member.objects.create(organisation=org, name="Zainab Yusuf", role="Preparer")
    Member.objects.create(organisation=org, name="Emeka Obi", role="Viewer")
    names = ["Amara Okeke", "Chidi Nwosu", "Fatima Ibrahim", "Oluwaseun Adeyemi", "Aisha Musa", "Tobechukwu Eze", "Bola Akinola", "Ifeoma Okoro", "Ibrahim Lawal", "Nneka Umeh", "David James", "Grace Etim"]
    today = timezone.localdate()
    for n, name in enumerate(names):
        c = Customer.objects.create(organisation=org, name=name, external_id=f"CUS-{1001+n}", email=f"sample{n+1}@example.com")
        loan = Loan.objects.create(organisation=org, customer=c, reference=f"LN-{2041+n}", product=["Asset finance", "Personal finance", "Cooperative loan"][n%3],
                                   consent_status=["Active", "Active", "Awaiting bank", "Not requested"][n%4],
                                   consent_max=(35000+n*5000)*100, consent_expiry=today+timedelta(days=210))
        for j in range(6):
            due = month_date(today, j-1) if j else today-timedelta(days=30)
            if j == 1:
                due = today + timedelta(days=(n%4)-1)
            inst = Instalment.objects.create(organisation=org, loan=loan, sequence=j+1, due_date=due, amount=loan.consent_max)
            if j == 0:
                inst.paid = inst.amount
                inst.state = "Paid"
                inst.save()
                Payment.objects.create(organisation=org, instalment=inst, reference=f"DEMO-{str(org.id)[:8]}-{n}", amount=inst.amount, paid_at=timezone.now()-timedelta(days=n%6), source="Pay-by-bank" if n%3 == 0 else "Direct debit")
            if j == 1 and n in [0, 3, 4, 7]:
                kind = {0:"Unknown result", 3:"Consent problem", 4:"Non-retryable failure", 7:"Unclear match"}[n]
                if n == 0:
                    inst.state = "Unknown"
                    loan.on_hold = True
                    loan.hold_reason = "Unknown result: awaiting final provider evidence."
                    loan.held_by = prep
                    loan.save()
                if n == 4:
                    inst.state = "Failed"
                inst.save()
                Review.objects.create(organisation=org, instalment=inst, kind=kind, amount=inst.amount, owner=reviewer, prepared_by=prep, deadline=timezone.now()+timedelta(days=-1 if n==0 else 2), evidence="Synthetic example for exploring the review process. No bank was contacted; no real money moved.")
    audit(org, prep, "Demo workspace created", "Synthetic examples loaded. Live payment processing is disabled.")
    return org, prep


def workspace_exists(request):
    org_id = request.session.get("org")
    return bool(org_id) and Organisation.objects.filter(pk=org_id).exists()


def context(request):
    # Workspaces are created only from the start page (a POST), never on a plain visit,
    # so crawlers, link previews and health checks cannot fill the database.
    org_id = request.session.get("org")
    org = Organisation.objects.filter(pk=org_id).first() if org_id else None
    if org is None:
        raise WorkspaceRequired
    now = timezone.now()
    if org.last_seen_at < now - timedelta(minutes=5):
        Organisation.objects.filter(pk=org.pk).update(last_seen_at=now)
    actor = Member.objects.filter(organisation=org, pk=request.session.get("actor")).first() or Member.objects.filter(organisation=org).first()
    # Expiry is a business state change, not a display-only label. The system expires it, not the viewer.
    with transaction.atomic():
        expired = PaymentRequest.objects.select_for_update().filter(organisation=org, status="Awaiting approval", expires_at__lte=now)
        for item in expired:
            item.status = "Expired"
            item.save(update_fields=["status"])
            audit(org, None, "Payment request expired", item.reference)
    return {"org": org, "actor": actor, "members": Member.objects.filter(organisation=org),
            "today": timezone.localdate(), "open_review_count": Review.objects.filter(organisation=org, status__in=["Open","In progress"]).count()}


def purge_demo_workspaces(idle_for=None, limit=None):
    """Delete demo workspaces idle longer than idle_for (default DEMO_WORKSPACE_RETENTION), then expired sessions.

    Sessions end after 30 idle minutes, so a purged workspace can no longer be opened. Returns the number deleted.
    """
    cutoff = timezone.now() - (settings.DEMO_WORKSPACE_RETENTION if idle_for is None else idle_for)
    purged = 0
    while limit is None or purged < limit:
        size = 50 if limit is None else min(50, limit - purged)
        with transaction.atomic():
            # skip_locked lets concurrent purges share the backlog instead of waiting on each other.
            ids = list(Organisation.objects.select_for_update(skip_locked=True).filter(demo=True, last_seen_at__lt=cutoff).values_list("pk", flat=True)[:size])
            if not ids:
                break
            for model in PURGE_ORDER:
                model.objects.filter(organisation_id__in=ids).delete()
            Organisation.objects.filter(pk__in=ids).delete()
        purged += len(ids)
    import_module(settings.SESSION_ENGINE).SessionStore.clear_expired()
    return purged


def validate_csv(text, org):
    errors, rows = [], []
    try:
        reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
        required = {"customer_id","name","email","phone","loan_id","product","amount","due_date"}
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            return ["Missing columns: " + ", ".join(sorted(required))], []
        seen = set()
        loan_owners = {}
        existing = set(Loan.objects.filter(organisation=org).values_list("reference", flat=True))
        existing_customers = set(Customer.objects.filter(organisation=org).values_list("external_id", flat=True))
        for n, row in enumerate(reader, 2):
            if n > 5001:
                errors.append("Maximum 5,000 instalments per import.")
                break
            try:
                if None in row or any(row.get(k) is None for k in required):
                    raise ValueError("column count does not match the template")
                row = {k: v.strip() for k,v in row.items()}
                for k in ["name", "customer_id", "loan_id"]:
                    if not row[k] or len(row[k]) > (120 if k == "name" else 60):
                        raise ValueError(f"{k}: required and too long values are not allowed")
                amount = Decimal(row["amount"])
                if not amount.is_finite() or amount <= 0 or amount.as_tuple().exponent < -2 or amount > Decimal("9999999999.99"):
                    raise ValueError("amount: use a positive number with at most two decimal places")
                due = date.fromisoformat(row["due_date"])
                if row["loan_id"] in existing:
                    raise ValueError("loan_id: already exists in this organisation")
                if row["customer_id"] in existing_customers:
                    raise ValueError("customer_id: already exists; use the customer form for existing records")
                if row["loan_id"] in loan_owners and loan_owners[row["loan_id"]] != row["customer_id"]:
                    raise ValueError("loan_id: belongs to two different customers")
                key = (row["loan_id"], row["due_date"])
                if key in seen:
                    raise ValueError("duplicate instalment for this loan and due date")
                if len(row["phone"]) > 30 or len(row["product"]) > 80:
                    raise ValueError("phone or product exceeds maximum length")
                if row["email"]:
                    from django.core.validators import validate_email
                    validate_email(row["email"])
                seen.add(key)
                loan_owners[row["loan_id"]] = row["customer_id"]
                rows.append({**row, "kobo": int(amount*100), "date": due})
            except (ValueError, InvalidOperation, Exception) as exc:
                errors.append(f"Row {n}: {exc}")
        if not rows and not errors:
            errors.append("No instalments found.")
    except csv.Error as exc:
        errors.append(f"CSV format error: {exc}")
    return errors, rows


@transaction.atomic
def commit_csv(rows, org, actor):
    # Serialize imports against customer creation for this tenant.
    Organisation.objects.select_for_update().get(pk=org.pk)
    customers, loans = {}, {}
    for row in sorted(rows, key=lambda r:(r["loan_id"], r["date"])):
        cid, lid = row["customer_id"], row["loan_id"]
        if cid not in customers:
            customers[cid] = Customer.objects.create(organisation=org, external_id=cid, name=row["name"], email=row["email"], phone=row["phone"])
        if lid not in loans:
            loans[lid] = Loan.objects.create(organisation=org, customer=customers[cid], reference=lid, product=row["product"] or "Personal finance")
        loan = loans[lid]
        Instalment.objects.create(organisation=org, loan=loan, sequence=loan.instalments.count()+1, due_date=row["date"], amount=row["kobo"])
        loan.consent_max = max(loan.consent_max, row["kobo"])
        loan.consent_expiry = row["date"]+timedelta(days=30)
        loan.save()
    audit(org, actor, "CSV imported", f"{len(rows)} instalments across {len(loans)} loans; all rows validated.")