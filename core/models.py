import secrets
import uuid
from django.db import models
from django.db.models import Q
from django.utils import timezone


def token():
    return secrets.token_urlsafe(32)


def money(kobo):
    return f"₦{kobo // 100:,}.{kobo % 100:02d}"


class Organisation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=120, default="Meridian Finance")
    retry_preset = models.CharField(max_length=12, default="Standard")
    receipts = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)


class Scoped(models.Model):
    organisation = models.ForeignKey(Organisation, on_delete=models.PROTECT)
    class Meta:
        abstract = True


class Member(Scoped):
    name = models.CharField(max_length=100)
    role = models.CharField(max_length=20)
    def __str__(self):
        return f"{self.name} · {self.role}"


class Customer(Scoped):
    name = models.CharField(max_length=120)
    external_id = models.CharField(max_length=60)
    email = models.EmailField(blank=True)
    phone = models.CharField(max_length=30, blank=True)
    class Meta:
        constraints = [models.UniqueConstraint(fields=["organisation", "external_id"], name="vp_customer_id")]
    @property
    def loan(self):
        return self.loans.first()


class Loan(Scoped):
    customer = models.ForeignKey(Customer, related_name="loans", on_delete=models.PROTECT)
    reference = models.CharField(max_length=60)
    product = models.CharField(max_length=80, default="Personal finance")
    status = models.CharField(max_length=20, default="Open")
    on_hold = models.BooleanField(default=False)
    hold_reason = models.TextField(blank=True)
    held_by = models.ForeignKey(Member, null=True, on_delete=models.PROTECT)
    consent_status = models.CharField(max_length=20, default="Not requested")
    consent_max = models.BigIntegerField(default=0)
    consent_expiry = models.DateField(null=True)
    consent_token = models.CharField(max_length=80, default=token, unique=True)
    consent_requested_at = models.DateTimeField(null=True)
    class Meta:
        constraints = [models.UniqueConstraint(fields=["organisation", "reference"], name="vp_loan_id")]
    @property
    def consent_max_display(self):
        return money(self.consent_max)


class Instalment(Scoped):
    loan = models.ForeignKey(Loan, related_name="instalments", on_delete=models.PROTECT)
    sequence = models.PositiveIntegerField()
    due_date = models.DateField()
    amount = models.BigIntegerField()
    paid = models.BigIntegerField(default=0)
    state = models.CharField(max_length=25, default="Upcoming")
    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["loan", "sequence"], name="vp_schedule_sequence"),
            models.CheckConstraint(condition=Q(amount__gt=0) & Q(paid__gte=0) & Q(paid__lte=models.F("amount")), name="vp_valid_money")]
    @property
    def status(self):
        if self.loan.on_hold:
            return "On hold"
        if self.paid == self.amount:
            return "Paid"
        if self.state in ["Failed", "Unknown", "In progress"]:
            return self.state
        if self.paid:
            return "Part-paid"
        return "Overdue" if self.due_date < timezone.localdate() else "Due" if self.due_date == timezone.localdate() else "Upcoming"
    @property
    def amount_display(self):
        return money(self.amount)
    @property
    def paid_display(self):
        return money(self.paid)
    @property
    def outstanding_display(self):
        return money(self.amount - self.paid)
    def __str__(self):
        return f"{self.loan.customer.name} · {self.loan.reference} / {self.sequence} · {self.outstanding_display}"


class PaymentRequest(Scoped):
    instalment = models.ForeignKey(Instalment, on_delete=models.PROTECT)
    reference = models.CharField(max_length=80, unique=True)
    amount = models.BigIntegerField()
    status = models.CharField(max_length=30, default="Awaiting approval")
    expires_at = models.DateTimeField()
    token = models.CharField(max_length=80, default=token, unique=True)
    class Meta:
        constraints = [models.UniqueConstraint(fields=["instalment"], condition=Q(status__in=["Awaiting approval", "Awaiting confirmation", "Unknown"]), name="vp_one_active_request")]
    @property
    def customer_name(self):
        return self.instalment.loan.customer.name
    @property
    def amount_display(self):
        return money(self.amount)


class Payment(Scoped):
    instalment = models.ForeignKey(Instalment, on_delete=models.PROTECT)
    reference = models.CharField(max_length=80, unique=True)
    amount = models.BigIntegerField()
    status = models.CharField(max_length=25, default="Confirmed")
    source = models.CharField(max_length=30, default="Direct debit")
    paid_at = models.DateTimeField()
    sample = models.BooleanField(default=True)
    @property
    def customer_name(self):
        return self.instalment.loan.customer.name
    @property
    def amount_display(self):
        return money(self.amount)


class Review(Scoped):
    instalment = models.ForeignKey(Instalment, on_delete=models.PROTECT)
    kind = models.CharField(max_length=50)
    amount = models.BigIntegerField(default=0)
    status = models.CharField(max_length=20, default="Open")
    owner = models.ForeignKey(Member, related_name="owned_reviews", on_delete=models.PROTECT)
    prepared_by = models.ForeignKey(Member, related_name="prepared_reviews", on_delete=models.PROTECT)
    resolved_by = models.ForeignKey(Member, null=True, related_name="resolved_reviews", on_delete=models.PROTECT)
    deadline = models.DateTimeField()
    evidence = models.TextField()
    note = models.TextField(blank=True)
    outcome = models.CharField(max_length=50, blank=True)
    @property
    def overdue(self):
        return self.status not in ["Resolved", "Dismissed"] and self.deadline < timezone.now()
    @property
    def customer_name(self):
        return self.instalment.loan.customer.name
    @property
    def amount_display(self):
        return money(self.amount)


class Refund(Scoped):
    payment = models.ForeignKey(Payment, on_delete=models.PROTECT)
    review = models.OneToOneField(Review, on_delete=models.PROTECT)
    amount = models.BigIntegerField()
    reason = models.TextField()
    status = models.CharField(max_length=20, default="Requested")


class Audit(Scoped):
    actor_name = models.CharField(max_length=100)
    action = models.CharField(max_length=120)
    detail = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    previous_hash = models.CharField(max_length=64, blank=True)
    digest = models.CharField(max_length=64)
    class Meta:
        ordering = ["-id"]