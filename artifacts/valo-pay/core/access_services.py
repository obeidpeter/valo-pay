"""Local staff access primitives. Outbound delivery is disabled outside isolated tests."""
import hashlib
import secrets
import time
from datetime import timedelta
from functools import wraps
from django.conf import settings
from django.contrib.auth import logout
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.mail import send_mail
from django.db import transaction
from django.shortcuts import redirect, get_object_or_404
from django.utils import timezone
from django.utils.crypto import salted_hmac
from django.utils.http import url_has_allowed_host_and_scheme
from .models import AccessRate, AccessToken, StaffMembership


def digest(raw):
    return hashlib.sha256(raw.encode()).hexdigest()


def throttle(request, purpose):
    key = salted_hmac("staff-rate", purpose + ":" + request.META.get("REMOTE_ADDR", "")).hexdigest()
    with transaction.atomic():
        AccessRate.objects.get_or_create(key=key, defaults={"starts_at": timezone.now()})
        row = AccessRate.objects.select_for_update().get(key=key)
        if row.starts_at < timezone.now() - timedelta(minutes=15):
            row.count = 0
            row.starts_at = timezone.now()
        row.count += 1
        row.save()
        return row.count > 10


def safe_next(value):
    import re
    from urllib.parse import urlsplit, unquote, parse_qsl, urlencode
    fallback="/access/organisations/"
    if not isinstance(value,str) or not url_has_allowed_host_and_scheme(value,allowed_hosts=set()):
        return fallback
    decoded=unquote(value)
    if "\\" in decoded or ".." in decoded or any(ord(c)<32 for c in decoded):
        return fallback
    url=urlsplit(value)
    if not re.fullmatch(r"/(?:(?:today|collections|reports|settings|import)/|customers/(?:new/|\d+/(?:edit/)?)?|payments/(?:new/|\d+/)?|reviews/(?:\d+/)?|access/(?:workspace|organisations|help|reset|login|enrol|challenge|email-code|invitations|settings)/|access/invitation/[A-Za-z0-9_-]+/)",url.path):
        return fallback
    query=urlencode([(k,v[:200]) for k,v in parse_qsl(url.query) if k in ("q","filter","page","type","records_page","requests_page")])
    return url.path+("?"+query if query else "")


def deliberate_navigation(request):
    return (request.method=="GET" and request.headers.get("Sec-Fetch-Mode")=="navigate"
            and request.headers.get("Sec-Fetch-Dest")=="document"
            and request.headers.get("Sec-Fetch-User")=="?1")


def deliver(email, subject, body):
    if (not getattr(settings, "ACCESS_TEST_DELIVERY", False)
            or settings.EMAIL_BACKEND != "django.core.mail.backends.locmem.EmailBackend"
            or not email.endswith("@example.invalid")):
        raise ValidationError("Verified delivery is unavailable. Nothing was sent.")
    if send_mail(subject, body, "access@example.invalid", [email]) != 1:
        raise ValidationError("Delivery failed. Nothing was activated.")


def issue(purpose, email, *, user=None, organisation=None, role="", minutes=30):
    raw = secrets.token_urlsafe(32)
    token = AccessToken.objects.create(digest=digest(raw), purpose=purpose, email=email,
        user=user, organisation=organisation, role=role,
        expires_at=timezone.now() + timedelta(minutes=minutes))
    return token, raw


def locked_token(raw, purpose):
    return AccessToken.objects.select_for_update().filter(digest=digest(raw), purpose=purpose,
        consumed_at__isnull=True, revoked=False, expires_at__gt=timezone.now()).first()


def staff_required(view):
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        if (not request.user.is_authenticated or not request.session.get("verified_at")
                or time.time() - request.session.get("staff_idle_at", 0) >= 1800):
            logout(request)
            from urllib.parse import urlencode
            return redirect("/access/login/?"+urlencode({"next":safe_next(request.get_full_path())}))
        if deliberate_navigation(request):
            membership(request)
            request.session["staff_idle_at"]=time.time()
        # Polls never update the idle clock.
        response = view(request, *args, **kwargs)
        if (request.method == "POST" or deliberate_navigation(request)) and response.status_code < 400 and request.user.is_authenticated:
            request.session["staff_idle_at"] = time.time()
        return response
    return wrapped


def membership(request, admin=False):
    result = StaffMembership.objects.filter(user=request.user, active=True,
        organisation_id=request.session.get("staff_org")).first()
    if not result or (admin and result.role != "Admin"):
        raise PermissionDenied("Current organisation access is unavailable.")
    return result


@transaction.atomic
def consume_fresh(request, action, target):
    """Call under the protected operation's transaction; never grants tenant/role authority."""
    member = membership(request)
    member = get_object_or_404(StaffMembership.objects.select_for_update(), pk=member.pk, active=True)
    proof = locked_token(request.session.pop("fresh_proof", ""), "fresh")
    if (not proof or proof.user_id != request.user.pk or proof.action != action
            or proof.target != str(target) or proof.organisation_id != member.organisation_id
            or proof.role != member.role):
        raise PermissionDenied("Fresh verification is required for this action and record.")
    proof.consumed_at = timezone.now()
    proof.save(update_fields=["consumed_at"])
    return member