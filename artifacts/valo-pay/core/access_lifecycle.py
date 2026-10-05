import time
from django import forms
from django.contrib.auth import get_user_model, logout
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.db import transaction
from django.shortcuts import render, redirect, get_object_or_404
from django.utils import timezone
from django.views.decorators.http import require_POST
from django_otp.plugins.otp_totp.models import TOTPDevice
from .models import StaffMembership, AccessToken, Refund, money
from .access_services import staff_required, membership, throttle, issue, deliver, locked_token, safe_next


class PasswordForm(forms.Form):
    password = forms.CharField(widget=forms.PasswordInput(attrs={"autocomplete": "new-password"}))
    confirm_password = forms.CharField(widget=forms.PasswordInput(attrs={"autocomplete": "new-password"}))
    def clean(self):
        data = super().clean()
        if data.get("password"):
            validate_password(data["password"], getattr(self, "target_user", None))
        if data.get("password") != data.get("confirm_password"):
            raise ValidationError("Passwords must match.")
        return data


class EmailForm(forms.Form):
    email = forms.EmailField(widget=forms.EmailInput(attrs={"autocomplete": "email"}))


class InviteForm(EmailForm):
    role = forms.ChoiceField(choices=StaffMembership._meta.get_field("role").choices)


def screen(request, title, form=None, notice="", **extra):
    if request.user.is_authenticated and request.session.get("verified_at"):
        extra.setdefault("idle_remaining", max(0,1800-int(time.time()-request.session.get("staff_idle_at",0))))
    return render(request, "access.html", dict(title=title, form=form, notice=notice, **extra))


@staff_required
def invitations(request):
    member = membership(request, admin=True)
    form = InviteForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        if throttle(request, "invite"):
            form.add_error(None, "Too many attempts. Try again in 15 minutes.")
        else:
            try:
                with transaction.atomic():
                    member = get_object_or_404(StaffMembership.objects.select_for_update(), pk=member.pk, active=True, role="Admin")
                    token, raw = issue("invite", form.cleaned_data["email"].lower(),
                        organisation=member.organisation, role=form.cleaned_data["role"], minutes=1440)
                    deliver(token.email, "Staff invitation",
                        request.build_absolute_uri("/access/invitation/" + raw + "/"))
                return screen(request, "Invitation issued", notice="The invitation was accepted by isolated test delivery. No real message was sent.")
            except ValidationError as exc:
                form.add_error(None, exc)
    return screen(request, "Invite a colleague", form,
        "Only current Admins may invite staff. Real delivery is disabled.",
        invitations=AccessToken.objects.filter(organisation=member.organisation, purpose="invite", consumed_at__isnull=True, revoked=False))


@staff_required
@require_POST
@transaction.atomic
def revoke(request, pk):
    member = membership(request, admin=True)
    get_object_or_404(StaffMembership.objects.select_for_update(), pk=member.pk, active=True, role="Admin")
    AccessToken.objects.filter(pk=pk, organisation=member.organisation, purpose="invite").update(revoked=True)
    return redirect("/access/invitations/")


@transaction.atomic
def accept(request, raw):
    token = locked_token(raw, "invite")
    if not token:
        return screen(request, "Invitation unavailable", notice="This invitation expired, was revoked or has already been used. Ask the inviting Admin for another.")
    existing = get_user_model().objects.filter(username=token.email).first()
    if existing:
        if request.user != existing or not request.session.get("verified_at") or time.time()-request.session.get("staff_idle_at",0) >= 1800:
            return redirect("/access/login/?next=" + request.path)
        form = forms.Form(request.POST or None)
    else:
        form = PasswordForm(request.POST or None)
        form.target_user = get_user_model()(username=token.email, email=token.email)
    if request.method == "POST":
        if throttle(request, "accept"):
            form.add_error(None, "Too many attempts. Try again in 15 minutes.")
        elif form.is_valid():
            user = existing or get_user_model().objects.create_user(
                username=token.email, email=token.email, password=form.cleaned_data["password"])
            # Existing active memberships are never silently escalated by invitation.
            StaffMembership.objects.get_or_create(user=user, organisation=token.organisation,
                defaults={"role": token.role})
            from .models import Member
            Member.objects.get_or_create(user=user, organisation=token.organisation,
                defaults={"role": token.role, "name": user.username})
            token.consumed_at = timezone.now()
            token.save(update_fields=["consumed_at"])
            if existing:
                return redirect("/access/organisations/")
            request.session.flush()
            request.session["pending_user"] = user.pk
            request.session["pending_auth_hash"] = user.get_session_auth_hash()
            request.session["pending_until"] = time.time()+300
            return redirect("/access/enrol/")
    return screen(request, "Accept invitation", form,
        f"Organisation: {token.organisation.name}. Role: {token.role}. Existing passwords and authenticators are never replaced.")


def pending(request):
    if request.session.get("pending_until",0) < time.time():
        return None
    user = get_user_model().objects.filter(pk=request.session.get("pending_user"), is_active=True).first()
    return user if user and request.session.get("pending_auth_hash") == user.get_session_auth_hash() else None


@transaction.atomic
def enrol(request):
    from .access import CodeForm, finish_login
    user = pending(request)
    if not user:
        return redirect("/access/login/")
    user = get_user_model().objects.select_for_update().get(pk=user.pk)
    if TOTPDevice.objects.filter(user=user, confirmed=True).exists():
        return redirect("/access/challenge/")
    device, _ = TOTPDevice.objects.get_or_create(user=user, name="staff", confirmed=False)
    form = CodeForm(request.POST or None)
    if request.method == "POST":
        if throttle(request, "enrol"):
            form.add_error(None, "Too many attempts. Try again in 15 minutes.")
        elif form.is_valid():
            device = TOTPDevice.objects.select_for_update().get(pk=device.pk)
            if device.verify_token(form.cleaned_data["code"]):
                device.confirmed = True
                device.save()
                return finish_login(request, user)
            form.add_error(None, "Use a current, unused code from the authenticator you just set up.")
    return screen(request, "Set up your authenticator", form,
        "Enter this setup key in your authenticator, then paste its current code. Staff access stays blocked until verified.",
        setup_key=__import__("base64").b32encode(device.bin_key).decode(), setup_uri=device.config_url)


def reset_request(request):
    form = EmailForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        if not throttle(request, "reset"):
            user = get_user_model().objects.filter(username=form.cleaned_data["email"].lower(), is_active=True).first()
            if user:
                try:
                    with transaction.atomic():
                        token, raw = issue("reset", user.email, user=user)
                        deliver(user.email, "Password reset", request.build_absolute_uri("/access/reset/"+raw+"/"))
                except ValidationError:
                    pass
        return screen(request, "Check account recovery", notice="If eligible and delivery is configured, recovery instructions are available through that channel. Real email is disabled in this preview; no real message was sent. Your authenticator remains required.")
    return screen(request, "Reset your password", form, "Password recovery does not remove two-step verification.")


@transaction.atomic
def reset_complete(request, raw):
    token = locked_token(raw, "reset")
    if not token:
        return screen(request, "Reset link unavailable", notice="This link expired or was already used. Request a new one.")
    form = PasswordForm(request.POST or None)
    form.target_user = token.user
    if request.method == "POST":
        if throttle(request, "reset-complete"):
            form.add_error(None, "Too many attempts. Try again in 15 minutes.")
        elif form.is_valid():
            user = get_user_model().objects.select_for_update().get(pk=token.user_id)
            user.set_password(form.cleaned_data["password"])
            user.save()
            AccessToken.objects.filter(user=user, purpose="reset", consumed_at__isnull=True).update(revoked=True)
            token.consumed_at = timezone.now()
            token.save(update_fields=["consumed_at"])
            logout(request)
            return redirect("/access/login/")
    return screen(request, "Choose a new password", form, "Two-step verification is still required after resetting.")


@staff_required
def workspace(request):
    member = membership(request)
    return screen(request, "Staff workspace", notice=f"{member.organisation.name} · {member.role}. Live financial processing is disabled.",
                  staff_member=member, idle_remaining=max(0,1800-int(time.time()-request.session["staff_idle_at"])),
                  staff_refunds=Refund.objects.filter(
                      organisation=member.organisation, status="Requested", review__prepared_by__user__isnull=False))


@staff_required
@require_POST
def continue_session(request):
    membership(request)
    request.session["staff_idle_at"] = time.time()
    if request.headers.get("X-Valo-Activity")=="input":
        from django.http import JsonResponse
        return JsonResponse({"remaining":1800})
    return redirect(safe_next(request.POST.get("next","/access/workspace/")))


@staff_required
def staff_settings(request):
    member = membership(request, admin=True)
    return screen(request, "Payment connection settings", notice="No payment provider is connected. Changes require fresh, action-bound authenticator verification, but connection changes remain blocked until a real provider integration is approved. No credentials are collected here.",
        verify_url="/access/fresh/?action=paystack-change&target=connection")


@require_POST
def email_fallback(request):
    user = pending(request)
    if not user or not TOTPDevice.objects.filter(user=user, confirmed=True).exists():
        return redirect("/access/login/")
    if throttle(request, "email-fallback"):
        return screen(request, "Try again later", notice="Wait 15 minutes before requesting another code.")
    try:
        with transaction.atomic():
            get_user_model().objects.select_for_update().get(pk=user.pk)
            AccessToken.objects.filter(user=user, purpose="email").update(revoked=True)
            token, raw = issue("email", user.email, user=user, minutes=5)
            deliver(user.email, "Two-step verification code", raw)
            request.session["email_token"] = token.pk
        return redirect("/access/email-code/")
    except ValidationError:
        return screen(request, "Email verification unavailable",
            notice="Verified email delivery is not configured in this preview. No message was sent. Use your authenticator or controlled account help.")


@transaction.atomic
def email_code(request):
    from .access import finish_login
    user = pending(request)
    if not user:
        return redirect("/access/login/")
    class EmailCodeForm(forms.Form):
        code = forms.CharField(max_length=100, widget=forms.TextInput(attrs={"autocomplete": "one-time-code"}))
    form = EmailCodeForm(request.POST or None)
    if request.method == "POST":
        if throttle(request, "email-code"):
            form.add_error(None, "Too many attempts. Try again in 15 minutes.")
        elif form.is_valid():
            token = locked_token(form.cleaned_data["code"], "email")
            if token and token.user_id == user.pk and token.pk == request.session.get("email_token"):
                token.consumed_at = timezone.now()
                token.save(update_fields=["consumed_at"])
                request.session.pop("email_token", None)
                return finish_login(request, user)
            form.add_error("code", "This code is invalid, expired or already used. Request another or use your authenticator.")
    return screen(request, "Verify your email code", form, "Paste the single-use code from isolated test delivery. This is not a password reset.")


@staff_required
@transaction.atomic
def fresh(request):
    from .access import CodeForm
    member = membership(request)
    class FreshForm(CodeForm):
        action = forms.ChoiceField(choices=[("paystack-change", "Change payment connection"), ("refund-approval", "Approve a refund")])
        target = forms.CharField(max_length=100)
    form = FreshForm(request.POST or None, initial={"action": request.GET.get("action"), "target": request.GET.get("target")})
    if request.method == "POST" and form.is_valid():
        if throttle(request, "fresh"):
            form.add_error(None, "Too many attempts. Try again in 15 minutes.")
        else:
            member = get_object_or_404(StaffMembership.objects.select_for_update(), pk=member.pk, active=True)
            action, target = form.cleaned_data["action"], form.cleaned_data["target"]
            allowed = member.role == "Admin" if action == "paystack-change" else member.role in ("Admin", "Reviewer")
            if not allowed:
                form.add_error(None, "Your current role cannot perform this action.")
            else:
                device = TOTPDevice.objects.select_for_update().filter(user=request.user, confirmed=True).first()
                if device and device.verify_token(form.cleaned_data["code"]):
                    proof, raw = issue("fresh", request.user.email, user=request.user,
                        organisation=member.organisation, role=member.role, minutes=5)
                    proof.action = action
                    proof.target = target
                    proof.save(update_fields=["action","target"])
                    request.session["fresh_proof"] = raw
                    return screen(request, "Identity rechecked", notice="This check applies only to the selected action and record for five minutes. No action was submitted. Live payment connection changes and refund execution remain disabled.",
                        return_to=f"/access/refunds/{target}/" if action=="refund-approval" and target.isdigit() else "/access/workspace/")
                form.add_error("code", "Use a current unused authenticator code.")
    return screen(request, "Verify a sensitive action", form, "Verification never submits or replays a financial action.")


@staff_required
@transaction.atomic
def staff_refund(request, pk):
    from django.shortcuts import get_object_or_404
    from django.core.exceptions import PermissionDenied
    from django.db.models import Sum
    from .models import Refund, Payment, Review, Member
    from .access_services import consume_fresh
    from .services import audit
    member = membership(request)
    from .models import Organisation
    Organisation.objects.select_for_update().get(pk=member.organisation_id)
    member = get_object_or_404(StaffMembership.objects.select_for_update(), pk=member.pk, active=True)
    refund = get_object_or_404(Refund.objects.select_for_update(), pk=pk, organisation=member.organisation)
    review = get_object_or_404(Review.objects.select_for_update(), pk=refund.review_id, organisation=member.organisation)
    payment = get_object_or_404(Payment.objects.select_for_update(), pk=refund.payment_id, organisation=member.organisation)
    if (member.role not in ("Admin", "Reviewer") or not review.prepared_by.user_id
            or review.prepared_by.user_id == request.user.pk
            or review.prepared_by.organisation_id != member.organisation_id
            or payment.instalment.organisation_id != member.organisation_id
            or review.instalment.organisation_id != member.organisation_id
            or payment.instalment.loan.organisation_id != member.organisation_id
            or payment.instalment.loan.customer.organisation_id != member.organisation_id):
        raise PermissionDenied("A separate verified reviewer is required. Demo identities cannot authorize staff decisions.")
    class DecisionForm(forms.Form):
        decision = forms.ChoiceField(choices=[("approve","Approve"), ("reject","Reject")])
        note = forms.CharField(max_length=2000, widget=forms.Textarea)
    form = DecisionForm(request.POST or None)
    from .business_days import approval_deadline_error
    deadline_error = approval_deadline_error(review)
    if request.method=="POST" and form.is_valid():
        if (refund.status!="Requested" or review.status not in ("Open","In progress")
                or payment.status!="Confirmed" or payment.instalment_id!=review.instalment_id):
            form.add_error(None,"This payment or review changed. No decision was saved.")
        elif form.cleaned_data["decision"] == "approve" and deadline_error:
            form.add_error(None, deadline_error)
        else:
            total = Refund.objects.filter(payment=payment).exclude(status__in=["Failed","Rejected"]).aggregate(total=Sum("amount"))["total"] or 0
            if total>payment.amount:
                form.add_error(None,"Reserved refunds exceed the payment. Investigate before deciding.")
            else:
                consume_fresh(request,"refund-approval",str(pk))
                actor, _ = Member.objects.get_or_create(user=request.user, organisation=member.organisation,
                    defaults={"role":member.role,"name":request.user.username})
                approved = form.cleaned_data["decision"]=="approve"
                refund.status = "Approved" if approved else "Rejected"
                refund.save(update_fields=["status"])
                review.status = "Resolved" if approved else "Dismissed"
                review.outcome = refund.status
                review.note = form.cleaned_data["note"]
                review.resolved_by = actor
                review.save()
                audit(member.organisation, actor, "Staff refund decision", f"Refund {pk}: {refund.status}; provider execution disabled",
                    subject=refund,before={"status":"Requested"},after={"status":refund.status},reason=form.cleaned_data["note"])
                return screen(request,"Decision recorded",notice="The independent decision was saved. No refund was executed and no payment provider was contacted.")
    return screen(request,"Review refund",form,notice=f"{payment.amount_display} confirmed payment. Refund: {money(refund.amount)}. {review.deadline_label}. {deadline_error} Independent decision only; no money moves. Rejection remains available with fresh verification.",
        verify_url=f"/access/fresh/?action=refund-approval&target={pk}")