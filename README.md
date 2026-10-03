# Valo Pay

Django and PostgreSQL collections and Pay-by-bank operations sandbox for Nigerian lenders.

## Status

**Synthetic-data demo only — not production-ready.** Role switching is simulated, not authentication. No real payments or emails are sent. Never enter real customer data. See [RELEASE_SCOPE.md](RELEASE_SCOPE.md) for implemented features and launch blockers.

## Included

Customer records, instalment schedules, CSV import, demo consent and payment links, holds, review queues, separate-person refund approval, CSV reports, and audit history. Credit Desk and Cash Desk are previews.

## Setup

Requires Python 3.12+, PostgreSQL and an HTTPS reverse proxy.

1. Install Python dependencies listed in pyproject.toml (for example, `uv sync`).
2. Set `DATABASE_URL` and a strong random `SESSION_SECRET` in your runtime secret manager. Never commit their values.
3. For a new development database, run `uv run python manage.py migrate`.
4. Run `uv run python manage.py collectstatic --noinput`.
5. Start with `uv run gunicorn valo.wsgi:application --bind 0.0.0.0:8000`.

For development, `uv run python manage.py runserver 0.0.0.0:8000` is also available. Secure cookies require HTTPS for functional browser sessions. Configure CSRF_TRUSTED_ORIGINS and ALLOWED_HOSTS in valo/settings.py for your actual host. Trust forwarded HTTPS headers only from a controlled reverse proxy. Current defaults target the Replit preview and must be reviewed before other hosting.

Validate configuration with `uv run python manage.py check`. The first browser visit creates synthetic records in an isolated session workspace.

## Repository layout

- core/: models, migrations, forms, services and views
- valo/: Django settings, routes and WSGI entry point
- templates/ and static/: server-rendered interface
- RELEASE_SCOPE.md: known limitations and launch requirements

This repository is a source snapshot of the Valo Pay app from the Replit workspace, with the Django app at the repository root. Unrelated starter apps, uploaded business documents, generated files, databases and secrets are excluded. It is not an automatic sync of the workspace or its Git history.
