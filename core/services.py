import csv
import hashlib
import io
import calendar
from datetime import timedelta, date
from decimal import Decimal, InvalidOperation
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone
from .models import Organisation, Member, Customer, Loan, Instalment, Payment, Review, Audit, PaymentRequest


def audit(org, actor, action, detail, *, subject=None, before=None, after=None, reason="", customer_ids=None):
    import json
    scope=customer_ids or []
    if subject is not None:
        if isinstance(subject,Customer): scope=[str(subject.pk)]
        elif isinstance(subject,Loan): scope=[str(subject.customer_id)]
        elif hasattr(subject,"instalment"): scope=[str(subject.instalment.loan.customer_id)]
        elif hasattr(subject,"payment"): scope=[str(subject.payment.instalment.loan.customer_id)]
    structured=json.loads(json.dumps({"actor_user_id":actor.user_id,"entity_type":type(subject).__name__ if subject else "",
        "entity_id":str(subject.pk) if subject else "", "customer_ids":scope,
        "before_state":before or {}, "after_state":after or {}, "reason":reason},default=str))
    # Lock the tenant while appending, so concurrent writes cannot fork the chain.
    Organisation.objects.select_for_update().get(pk=org.pk)
    prev = Audit.objects.filter(organisation=org).first()
    previous = prev.digest if prev else ""
    digest = hashlib.sha256(f"{previous}|{actor.name}|{action}|{detail}|{json.dumps(structured,sort_keys=True)}".encode()).hexdigest()
    Audit.objects.create(organisation=org, actor_name=actor.name, action=action, detail=detail, previous_hash=previous,
        digest=digest,schema_version=2,**structured)


def month_date(start, offset):
    month = start.month - 1 + offset
    year = start.year + month // 12
    month = month % 12 + 1
    return date(year, month, min(start.day, calendar.monthrange(year, month)[1]))


@transaction.atomic
def seed_demo():
    org = Organisation.objects.create()
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
                # New demos also illustrate a due debit blocked by pending consent.
                due = today if n == 2 else today + timedelta(days=(n%4)-1)
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
                from .business_days import review_deadline
                deadline, basis = review_deadline(kind, timezone.now()-timedelta(days=7) if n==0 else timezone.now(), synthetic=True)
                Review.objects.create(organisation=org, instalment=inst, kind=kind, amount=inst.amount, owner=reviewer, prepared_by=prep, deadline=deadline, deadline_basis=basis, evidence="Synthetic example for exploring the review process. No bank was contacted; no real money moved.")
    audit(org, prep, "Demo workspace created", "Synthetic examples loaded. Live payment processing is disabled.")
    return org, prep


def context(request):
    from django.core.exceptions import PermissionDenied
    if request.user.is_authenticated:
        import time
        from .access_services import membership
        from .models import StaffMembership
        if not request.session.get("verified_at") or time.time()-request.session.get("staff_idle_at",0)>=1800:
            raise PermissionDenied("Sign in again to continue.")
        access=membership(request)
        org=access.organisation
        members=[]
        for m in StaffMembership.objects.filter(organisation=org,active=True,user__is_active=True).select_related("user"):
            principal,_=Member.objects.get_or_create(organisation=org,user=m.user,defaults={"name":m.user.username,"role":m.role})
            principal.role=m.role
            members.append(principal)
        actor=next((m for m in members if m.user_id==request.user.pk),None)
        if actor is None:
            raise PermissionDenied("Current membership is unavailable.")
    else:
        org_id = request.session.get("org")
        org = Organisation.objects.filter(pk=org_id).first() if org_id else None
        if org is None:
            raise PermissionDenied("Open the demo start page to intentionally create sample data.")
        from .models import StaffMembership
        if StaffMembership.objects.filter(organisation=org).exists() or Member.objects.filter(organisation=org,user__isnull=False).exists():
            raise PermissionDenied("Staff organisations cannot be accessed through simulated roles.")
        actor = Member.objects.filter(organisation=org, pk=request.session.get("actor"),user__isnull=True).first()
        if actor is None:
            raise PermissionDenied("This demo role is no longer available. Start a separate demo session.")
        members=Member.objects.filter(organisation=org,user__isnull=True)
    # Expiry is a business state change, not a display-only label.
    with transaction.atomic():
        Organisation.objects.select_for_update().get(pk=org.pk)
        expired = PaymentRequest.objects.select_for_update().filter(organisation=org, status="Awaiting approval", expires_at__lte=timezone.now())
        for item in expired:
            item.status = "Expired"
            item.save(update_fields=["status"])
            from types import SimpleNamespace
            audit(org, SimpleNamespace(name="System", user_id=None), "Payment request expired", item.reference,subject=item,
                  before={"status":"Awaiting approval"},after={"status":"Expired"},reason="Request expiry reached")
    from .demo_flow import tour_bar
    return {"org": org, "actor": actor, "members": members,"staff_mode":request.user.is_authenticated,
            "demo_tour": tour_bar(request),
            "can_prepare":actor.role in ("Admin","Preparer"),"can_review":actor.role in ("Admin","Reviewer"),
            "can_hold":actor.role in ("Admin","Preparer","Reviewer"),"can_admin":actor.role=="Admin",
            "idle_remaining":max(0,1800-int(__import__("time").time()-request.session.get("staff_idle_at",0))) if request.user.is_authenticated else None,
            "today": timezone.localdate(), "open_review_count": Review.objects.filter(organisation=org, status__in=["Open","In progress"]).count()}


def validate_csv(text, org):
    errors, rows = [], []
    try:
        reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
        required = {"customer_id","name","email","phone","loan_id","product","amount","due_date"}
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            return ["Missing columns: " + ", ".join(sorted(required - set(reader.fieldnames or [])))], []
        seen = set()
        loan_owners = {}
        customer_metadata = {}
        loan_metadata = {}
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
                field_errors = []
                try:
                    amount = Decimal(row["amount"])
                    if not amount.is_finite() or amount <= 0 or amount.as_tuple().exponent < -2 or amount > Decimal("9999999999.99"):
                        raise InvalidOperation
                except InvalidOperation:
                    field_errors.append("amount: enter a positive number up to 9999999999.99 with at most two decimal places, for example 18450.00")
                try:
                    due = date.fromisoformat(row["due_date"])
                    if due.isoformat() != row["due_date"]:
                        raise ValueError
                except ValueError:
                    field_errors.append("due_date: enter a real calendar date in YYYY-MM-DD format, for example 2026-10-31")
                if field_errors:
                    errors.extend(f"Row {n}: {message}" for message in field_errors)
                    continue
                if row["loan_id"] in existing:
                    raise ValueError("loan_id: already exists in this organisation")
                if row["customer_id"] in existing_customers:
                    raise ValueError("customer_id: already exists; use the customer form for existing records")
                if row["loan_id"] in loan_owners and loan_owners[row["loan_id"]] != row["customer_id"]:
                    raise ValueError("loan_id: belongs to two different customers")
                customer_values = tuple(row[k] for k in ("name", "email", "phone"))
                loan_values = (row["customer_id"], row["product"])
                if row["customer_id"] in customer_metadata and customer_metadata[row["customer_id"]] != customer_values:
                    raise ValueError("customer_id: repeated customer has conflicting name, email or phone")
                if row["loan_id"] in loan_metadata and loan_metadata[row["loan_id"]] != loan_values:
                    raise ValueError("loan_id: repeated loan has conflicting customer or product")
                customer_metadata[row["customer_id"]] = customer_values
                loan_metadata[row["loan_id"]] = loan_values
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
            except ValidationError:
                errors.append(f"Row {n}: email: enter a valid email address or leave it blank")
            except ValueError as exc:
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
    audit(org, actor, "CSV imported", f"{len(rows)} instalments across {len(loans)} loans; all rows validated.",
        customer_ids=[str(c.pk) for c in customers.values()],after={"loan_ids":[l.pk for l in loans.values()],"rows":len(rows)},reason="Confirmed validated import")