from datetime import timedelta
from django.utils import timezone


def consent_state(loan):
    valid = (loan.status == "Open" and loan.consent_status == "Requested"
             and loan.consent_requested_at and loan.consent_requested_at + timedelta(days=14) > timezone.now()
             and loan.consent_expiry and loan.consent_expiry >= timezone.localdate())
    if valid:
        return {}
    return {"status_heading": "Authorisation link unavailable",
            "status_detail": "This loan is closed, or this authorisation link is expired, withdrawn, already used or no longer pending. This does not establish whether earlier payments occurred. Contact your lender using its usual contact details."}


def payment_state(item):
    # Stored authoritative state always outranks link expiry and browser query strings.
    messages = {
        "Confirmed": ("Payment confirmed", "The stored payment-request state is Confirmed. Link expiry does not undo this result. Do not pay this request again."),
        "Awaiting confirmation": ("Awaiting confirmation", "The outcome is still being checked. Do not make another payment for this request."),
        "Unknown": ("Payment result unresolved", "The result is unknown. Do not pay again; ask your lender to reconcile the existing attempt."),
        "Failed": ("Payment attempt reported failed", "Contact your lender before retrying. This link does not establish whether any earlier attempt moved funds."),
        "Reversed": ("Payment reported reversed", "Ask your lender to confirm the repayment balance before taking another action."),
        "Cancelled": ("Request cancelled", "No further action is available through this link. Cancellation does not prove that no earlier payment occurred."),
        "Expired": ("Request expired", "No further action is available through this link. Expiry does not establish whether an earlier payment occurred."),
        "Used": ("Request already used", "Do not pay again through this link. Ask your lender for the latest reconciled result."),
    }
    if item.status in messages:
        heading, detail = messages[item.status]
    elif item.status != "Awaiting approval":
        heading, detail = "Request unavailable", "Ask your lender for the latest result before making any payment."
    elif item.expires_at <= timezone.now():
        heading, detail = messages["Expired"]
    elif item.instalment.loan.status != "Open" or item.instalment.loan.on_hold:
        heading, detail = "Request paused", "The loan is closed or on hold. Do not submit a new payment through this link."
    elif item.instalment.state in ("Unknown", "In progress") or item.instalment.paid >= item.instalment.amount:
        heading, detail = "Check the existing repayment", "This instalment is settled or has an unresolved attempt. Do not pay again."
    else:
        return {}
    return {"status_heading": heading, "status_detail": detail}