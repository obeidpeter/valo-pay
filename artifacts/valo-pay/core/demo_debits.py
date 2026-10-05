"""Synthetic debit simulation adapted from GitHub; never a provider execution path."""
from django.contrib import messages
from django.core.exceptions import PermissionDenied
from django.db import transaction
from django.shortcuts import redirect
from django.utils import timezone
from django.views.decorators.http import require_POST
from . import demo_flow
from .models import Instalment, Loan, Organisation, Payment, PaymentRequest, Review
from .services import audit, context


def blocker(inst, busy, reviewed):
    loan = inst.loan
    if loan.status != "Open":
        return "Loan is closed"
    if loan.on_hold:
        return "Loan is on hold"
    if inst.state in ("Unknown", "In progress"):
        return "An earlier result is not final; do not retry"
    if inst.pk in busy:
        return "A payment request is still open"
    if inst.pk in reviewed:
        return "A review needs a decision"
    if inst.state == "Failed":
        return "Already failed; no automatic retry is scheduled in this demo"
    if loan.consent_status != "Active":
        return "Consent is not active"
    if not loan.consent_expiry or loan.consent_expiry < timezone.localdate():
        return "Consent is expired or has no verified expiry"
    if inst.amount - inst.paid > loan.consent_max:
        return "Outstanding amount exceeds the consent limit"
    return ""


def outlook(org, instalments):
    busy = set(PaymentRequest.objects.filter(
        organisation=org, status__in=["Awaiting approval", "Awaiting confirmation", "Unknown", "In progress"]
    ).values_list("instalment_id", flat=True))
    busy.update(Payment.objects.filter(organisation=org).exclude(
        status="Confirmed").values_list("instalment_id", flat=True))
    reviewed = set(Review.objects.filter(
        organisation=org, status__in=["Open", "In progress"]
    ).values_list("instalment_id", flat=True))
    rows = []
    for inst in instalments:
        reason = blocker(inst, busy, reviewed)
        if inst.paid >= inst.amount:
            state, words = "done", "Paid sample record"
        elif reason:
            state, words = "blocked", reason
        else:
            state, words = "ready", "Ready for the sample run"
        rows.append((inst, state, words))
    return rows


@require_POST
@transaction.atomic
def run(request):
    demo_flow.guard(request)
    oid = request.session.get("org")
    Organisation.objects.select_for_update().filter(pk=oid).first()
    if not demo_flow.available(request):
        raise PermissionDenied("Start a separate synthetic demo first.")
    c = context(request)
    org, actor = c["org"], c["actor"]
    if actor.role not in ("Admin", "Preparer"):
        raise PermissionDenied("Only a sample Admin or Preparer can run this simulation.")
    if Payment.objects.filter(organisation=org, sample=False).exists():
        raise PermissionDenied("This workspace contains non-sample payment records.")
    # Use the same tenant-first locking order as the existing financial actions.
    list(Loan.objects.select_for_update().filter(organisation=org).values_list("pk", flat=True))
    due = list(Instalment.objects.select_for_update(of=("self",)).filter(
        organisation=org, due_date=timezone.localdate()
    ).select_related("loan__customer").order_by("loan__reference", "sequence"))
    collected = failed = skipped = 0
    for inst, state, words in outlook(org, due):
        if state != "ready":
            skipped += 1
            continue
        before = {"paid": inst.paid, "state": inst.state}
        if (collected + failed + 1) % 3 == 0:
            inst.state = "Failed"
            failed += 1
        else:
            Payment.objects.create(
                organisation=org, instalment=inst,
                reference=f"DEMO-DD-{org.pk}-{inst.pk}",
                amount=inst.amount - inst.paid, paid_at=timezone.now(),
                source="Direct debit", sample=True,
            )
            inst.paid, inst.state = inst.amount, "Paid"
            collected += 1
        inst.save(update_fields=["paid", "state"])
        audit(org, actor, "Sample debit outcome", f"Sample outcome: {inst.state}. No bank was contacted.",
              subject=inst, before=before, after={"paid": inst.paid, "state": inst.state},
              reason="Explicit synthetic-only simulation")
    audit(org, actor, "Sample debit run", f"{collected} collected, {failed} failed, {skipped} skipped. No real money moved.")
    messages.success(request, f"Sample run: {collected} collected, {failed} failed, {skipped} skipped. No bank was contacted; no automatic retries are scheduled.")
    return redirect("/today/#due-today")
