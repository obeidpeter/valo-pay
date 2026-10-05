import hashlib
from django.conf import settings
from django.core.exceptions import ValidationError


class BreachedPasswordValidator:
    """Use an explicitly provisioned offline SHA-1 breach corpus; never send passwords."""
    def validate(self, password, user=None):
        hashes = getattr(settings, "BREACHED_PASSWORD_SHA1", None)
        if hashes is None:
            raise ValidationError("Password setup is unavailable until the breached-password checker is configured.")
        if hashlib.sha1(password.encode()).hexdigest().upper() in {v.upper() for v in hashes}:
            raise ValidationError("This password appears in the configured breached-password list. Choose another.")

    def get_help_text(self):
        return "Use at least 12 characters and a password not present in the configured breached-password list."