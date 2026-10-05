"""Exact configured hosts only; never trust request headers to extend this list."""
import re
from django.core.exceptions import ImproperlyConfigured


def trusted_hosts(environ):
    if environ.get("REPLIT_DEPLOYMENT") == "1" and not (
        environ.get("REPLIT_DOMAINS", "").strip() or environ.get("VALO_ALLOWED_HOSTS", "").strip()
    ):
        raise ImproperlyConfigured("Publication requires platform domains or explicit exact application hosts.")
    values = [
        environ.get("REPLIT_DEV_DOMAIN", ""),
        environ.get("REPLIT_DOMAINS", ""),
        environ.get("VALO_ALLOWED_HOSTS", ""),
    ]
    hosts = {"localhost", "127.0.0.1", "[::1]"}
    for value in values:
        for item in value.split(","):
            host = item.strip().lower()
            if not host:
                continue
            if len(host) > 253 or not re.fullmatch(
                r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*", host
            ):
                raise ImproperlyConfigured("Host configuration must contain exact hostnames, not URLs, ports or wildcards.")
            hosts.add(host)
    if environ.get("REPLIT_DEPLOYMENT") == "1" and hosts == {"localhost", "127.0.0.1", "[::1]"}:
        raise ImproperlyConfigured("Publication requires configured exact application hosts.")
    return sorted(hosts)