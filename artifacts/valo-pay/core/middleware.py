from django.conf import settings
from django.http import HttpResponse


class InternalReadiness:
    """Only a direct loopback root probe bypasses the HTTPS redirect.

    Never enter application views/sessions or infer locality from forwarding
    headers. The startup command has already checked schema read-only.
    """
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        meta = request.META
        if (
            settings.IS_PUBLISHED
            and request.method in {"GET", "HEAD"}
            and request.get_full_path() == "/"
            and meta.get("REMOTE_ADDR") in {"127.0.0.1", "::1"}
            and meta.get("HTTP_HOST") in {
                "127.0.0.1", "localhost", "[::1]", "127.0.0.1:1104",
                f"127.0.0.1:{meta.get('SERVER_PORT')}",
                f"localhost:{meta.get('SERVER_PORT')}",
                f"[::1]:{meta.get('SERVER_PORT')}",
            }
            and meta.get("wsgi.url_scheme") == "http"
            and not any(
                key == "HTTP_FORWARDED"
                or (key.startswith("HTTP_X_FORWARDED_") and key != "HTTP_X_FORWARDED_FOR")
                for key in meta
            )
            # The internal router may append its direct loopback client.
            and meta.get("HTTP_X_FORWARDED_FOR", "") in {"", "127.0.0.1", "::1"}
        ):
            response = HttpResponse("ok\n", content_type="text/plain")
            response["Cache-Control"] = "no-store"
            response["X-Content-Type-Options"] = "nosniff"
            response["X-Frame-Options"] = "DENY"
            return response
        return self.get_response(request)


class TrustedHost:
    """Enforce ALLOWED_HOSTS on every route, including static and safe GETs."""
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.get_host()
        return self.get_response(request)


class PrivacyHeaders:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        # Keep Origin on same-origin form POSTs; never send token URLs cross-origin.
        response["Referrer-Policy"] = "same-origin"
        if request.path != "/" and not request.path.startswith("/static/"):
            response["X-Robots-Tag"] = "noindex, nofollow, noarchive"
            response["Cache-Control"] = "no-store"
        return response