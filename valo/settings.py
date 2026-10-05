import os
from pathlib import Path
import dj_database_url

BASE_DIR = Path(__file__).resolve().parent.parent
SECRET_KEY = os.environ["SESSION_SECRET"]
DEBUG = False
IS_PUBLISHED = os.environ.get("REPLIT_DEPLOYMENT") == "1"
from .hosts import trusted_hosts
ALLOWED_HOSTS = trusted_hosts(os.environ)
# The proxy supplies the original Host and HTTPS scheme. Same-origin CSRF is
# accepted by Django without a cross-origin allowlist.
CSRF_TRUSTED_ORIGINS = []
INSTALLED_APPS = ["django.contrib.auth", "django_otp", "django_otp.plugins.otp_totp", "django.contrib.contenttypes", "django.contrib.sessions",
                  "django.contrib.messages", "django.contrib.staticfiles", "core"]
MIDDLEWARE = ["core.middleware.TrustedHost",
              "core.middleware.InternalReadiness",
              "django.middleware.security.SecurityMiddleware",
              "core.middleware.PrivacyHeaders",
              "whitenoise.middleware.WhiteNoiseMiddleware",
              "django.contrib.sessions.middleware.SessionMiddleware",
              "django.contrib.auth.middleware.AuthenticationMiddleware",
              "core.operational_access.OperationalAccess",
              "django.middleware.common.CommonMiddleware",
              "django.middleware.csrf.CsrfViewMiddleware",
              "django.contrib.messages.middleware.MessageMiddleware",
              "django.middleware.clickjacking.XFrameOptionsMiddleware"]
ROOT_URLCONF = "valo.urls"
TEMPLATES = [{"BACKEND": "django.template.backends.django.DjangoTemplates",
              "DIRS": [BASE_DIR / "templates"], "APP_DIRS": True,
              "OPTIONS": {"context_processors": [
                  "django.contrib.auth.context_processors.auth",
                  "django.template.context_processors.request",
                  "django.contrib.messages.context_processors.messages"]}}]
DATABASES = {"default": dj_database_url.config(conn_max_age=60)}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
TIME_ZONE = "Africa/Lagos"
# No approved calendar has been supplied. Configure only after authorised review;
# see docs/BUSINESS_DAY_CALENDAR.md. Never infer holidays from missing coverage.
REVIEW_BUSINESS_CALENDAR = None
USE_TZ = True
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_DIRS = [BASE_DIR / "static"]
WHITENOISE_USE_FINDERS = False
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_SECURE = True
SESSION_COOKIE_AGE = 1800
SESSION_SAVE_EVERY_REQUEST = False
PASSWORD_HASHERS = ["django.contrib.auth.hashers.Argon2PasswordHasher"]
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "core.passwords.BreachedPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 12}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]
CSRF_COOKIE_SECURE = True
CSRF_FAILURE_VIEW = "core.errors.csrf_failure"
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = IS_PUBLISHED
SECURE_HSTS_SECONDS = 3600 if IS_PUBLISHED else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = False
SECURE_HSTS_PRELOAD = False
X_FRAME_OPTIONS = "DENY" if IS_PUBLISHED else "SAMEORIGIN"
DATA_UPLOAD_MAX_MEMORY_SIZE = 3 * 1024 * 1024