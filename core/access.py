"""Staff access is separate from synthetic demo identities. No delivery backend."""
import time
from django import forms
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.decorators import login_required
from django.shortcuts import render, redirect
from django.views.decorators.http import require_POST
from django_otp.plugins.otp_totp.models import TOTPDevice
from django.core.cache import cache
from django.utils.crypto import salted_hmac
from .access_services import throttle, safe_next


class SignInForm(forms.Form):
    email = forms.EmailField(widget=forms.EmailInput(attrs={"autocomplete": "username"}))
    password = forms.CharField(widget=forms.PasswordInput(attrs={"autocomplete": "current-password"}))


class CodeForm(forms.Form):
    code = forms.CharField(max_length=6, min_length=6, widget=forms.TextInput(
        attrs={"autocomplete": "one-time-code", "inputmode": "numeric"}))


def limited(request):
    return throttle(request, "signin")


def finish_login(request, user):
    destination = safe_next(request.session.get("safe_next",""))
    login(request, user, backend="django.contrib.auth.backends.ModelBackend")
    request.session.pop("pending_user", None)
    request.session.pop("pending_until", None)
    request.session.pop("pending_auth_hash", None)
    request.session.pop("safe_next", None)
    request.session["verified_at"] = time.time()
    request.session["staff_idle_at"] = time.time()
    if not destination.startswith("/access/"):
        request.session["post_org_next"]=destination
        return redirect("/access/organisations/")
    return redirect(destination)


def signin(request):
    form = SignInForm(request.POST or None)
    if request.method == "POST":
        if limited(request):
            form.add_error(None, "Too many attempts. Wait 15 minutes before trying again.")
        elif form.is_valid():
            user = authenticate(request, username=form.cleaned_data["email"].lower(), password=form.cleaned_data["password"])
            if user and user.is_active:
                request.session.flush()
                request.session["pending_user"] = user.pk
                request.session["pending_auth_hash"] = user.get_session_auth_hash()
                request.session["pending_until"] = time.time() + 300
                request.session["safe_next"] = safe_next(request.GET.get("next",""))
                return redirect("access_challenge")
            form.add_error(None, "We could not verify these details. Check them or use account help.")
    return render(request, "access.html", {"form": form, "title": "Staff sign in"})


def challenge(request):
    from django.contrib.auth import get_user_model
    if request.session.get("pending_until", 0) < time.time():
        return redirect("access_login")
    user = get_user_model().objects.filter(pk=request.session.get("pending_user"), is_active=True).first()
    if not user:
        return redirect("access_login")
    if request.session.get("pending_auth_hash") != user.get_session_auth_hash():
        request.session.flush()
        return redirect("access_login")
    form = CodeForm(request.POST or None)
    device = TOTPDevice.objects.filter(user=user, confirmed=True).first()
    if request.method == "POST":
        if limited(request):
            form.add_error(None, "Too many attempts. Wait 15 minutes before trying again.")
        elif form.is_valid():
            from django.db import transaction
            with transaction.atomic():
                locked = TOTPDevice.objects.select_for_update().filter(pk=device.pk).first() if device else None
                if locked and locked.verify_token(form.cleaned_data["code"]):
                    return finish_login(request, user)
            form.add_error(None, "This code could not be verified. Use a current, unused authenticator code.")
    if not device:
        return redirect("/access/enrol/")
    return render(request, "access.html", {"form": form, "title": "Two-step verification", "fallback_available": True,
        "notice": "Paste a current unused authenticator code. Lost your authenticator? Use controlled account help."})


@login_required(login_url="/access/login/")
def organisations(request):
    # Never substitute demo roles for real memberships.
    if not request.session.get("verified_at") or time.time() - request.session.get("staff_idle_at", 0) >= 1800:
        logout(request)
        return redirect("access_login")
    from .models import StaffMembership
    memberships = StaffMembership.objects.filter(user=request.user, active=True).select_related("organisation")
    class OrganisationForm(forms.Form):
        organisation = forms.ModelChoiceField(queryset=memberships, empty_label="Choose your organisation")
    form = OrganisationForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        request.session["staff_org"] = str(form.cleaned_data["organisation"].organisation_id)
        request.session["staff_idle_at"] = time.time()
        destination=safe_next(request.session.pop("post_org_next","/today/"))
        return redirect("/today/" if destination=="/access/organisations/" else destination)
    return render(request, "access.html", {"title": "Choose an organisation", "form": form,
        "idle_remaining": max(0,1800-int(time.time()-request.session["staff_idle_at"])),
        "notice": "Only current memberships are shown. No access? Contact the inviting Admin."})


def help_access(request):
    return render(request, "access.html", {"title": "Account access help",
        "notice": "Use your invitation to activate access, or request a password reset. Real email delivery is disabled here; no real message is sent. If both registered factors are unavailable, contact support for a controlled identity review. There is no automatic lost-factor bypass."})


@require_POST
def signout(request):
    logout(request)
    return redirect("access_login")