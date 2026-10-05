from django.shortcuts import render
from .models import Loan, PaymentRequest


def recovery(request, status, title, explanation):
    borrower = request.path.startswith(("/pay/", "/consent/"))
    lender = None
    back = "/access/workspace/" if getattr(request, "user", None) and request.user.is_authenticated else "/today/"
    if borrower:
        parts = request.path.strip("/").split("/")
        token = parts[1] if len(parts) == 2 else ""
        model = Loan if parts[0] == "consent" else PaymentRequest
        field = "consent_token" if model == Loan else "token"
        item = model.objects.filter(**{field: token}).select_related("organisation").first()
        lender = item.organisation.name if item else None
        back = request.path if item and status != 404 else None
    elif request.path.startswith("/access/"):
        back = "/access/login/"
    elif request.path.startswith("/payments/"):
        back = "/payments/"
    elif request.path.startswith("/loans/"):
        back = "/customers/"
    elif status == 404:
        back = "/"
    return render(request, "recovery.html", {"title": title, "explanation": explanation,
        "borrower": borrower, "lender": lender, "back": back, "status": status}, status=status)


def permission_denied(request, exception=None):
    return recovery(request, 403, "This action is not available to your role",
        "Your current access does not allow this action. No requested change was made. Ask an authorised administrator or reviewer for help.")


def not_found(request, exception=None):
    return recovery(request, 404, "This page or link is unavailable",
        "The address may be incorrect, no longer available or outside your access. This does not establish the outcome of any earlier payment.")


def csrf_failure(request, reason=""):
    category = ("origin" if "Origin" in reason else "referer" if "Referer" in reason else
                "cookie" if "cookie" in reason else "missing-token" if "missing" in reason else "token")
    response = recovery(request, 403, "Your form could not be verified",
        "This submission was rejected before the action ran. Reopen the page to get a fresh form. If an earlier payment is unresolved, check its status first—do not submit a second payment.")
    response["X-Valo-CSRF-Failure"] = category
    return response