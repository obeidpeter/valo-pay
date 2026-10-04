# Valo Pay

Django and PostgreSQL demo of Valo Pay: collections and Pay-by-bank software for Nigerian lenders and cooperatives.

## Status

**Demo with sample data only — not production-ready.** Choosing a team member to act as is not authentication. No real payments or emails are sent. Never enter real customer data. See [RELEASE_SCOPE.md](RELEASE_SCOPE.md) for implemented features and launch blockers.

## Included

Customer records, instalment schedules, CSV import, demo consent and payment links, holds, review queues, separate-person refund approval, CSV reports, and audit history. Credit Desk and Cash Desk are previews.

## Setup

Requires Python 3.12+, PostgreSQL and an HTTPS reverse proxy.

1. Install the locked Python dependencies with `uv sync` (uv.lock pins them).
2. Set `DATABASE_URL` and a strong random `SESSION_SECRET` in your runtime secret manager. Never commit their values.
3. For a new development database, run `uv run python manage.py migrate`.
4. Run `uv run python manage.py collectstatic --noinput`.
5. Start with `uv run gunicorn valo.wsgi:application --bind 0.0.0.0:8000`.

For development, `uv run python manage.py runserver 0.0.0.0:8000` is also available. Secure cookies require HTTPS for functional browser sessions. Configure CSRF_TRUSTED_ORIGINS and ALLOWED_HOSTS in valo/settings.py for your actual host. Trust forwarded HTTPS headers only from a controlled reverse proxy. Current defaults target the Replit preview and must be reviewed before other hosting.

Validate configuration with `uv run python manage.py check`. A visitor without a workspace sees a start page; choosing **Open the demo workspace** creates sample records in an isolated session workspace. Plain visits (crawlers, link previews, health checks) create nothing.

## Presenting the demo

The sidebar's Demo group has the **Demo guide**, a ten-step tour of the sample lender in which each step opens the right page and switches person in one click where needed, and the **Start page**, which offers **Continue the demo** or **Start again with fresh sample data**. Rehearse, then start again so the audience sees clean sample data. Sessions end after 30 minutes without activity (TRD FR-X1.3); if that happens, open the demo again from the start page. Customer pages are labelled "Customer's view", and nothing in the demo moves money or sends messages.

## Demo workspace cleanup

`uv run python manage.py purge_demo_workspaces` deletes demo workspaces with no activity for 24 hours, and expired sessions. Each new workspace also clears up to 10 idle ones, but schedule the command daily too (for example a scheduled deployment or cron job). Workspaces that existed before migration 0002 count as active from the moment it runs, so the first daily run a day later clears that backlog. `--idle-hours` overrides the period.

## Content and wording

User-facing wording follows [docs/content/content-guide.md](docs/content/content-guide.md). State explanations shown next to TRD labels live in core/content.py. [docs/content/copy-review.md](docs/content/copy-review.md) records coverage, test results, discrepancies and the wording that needs owner approval; [copy-inventory.csv](docs/content/copy-inventory.csv) lists each change with its reason and source, and [copy-walk-diff.csv](docs/content/copy-walk-diff.csv) is the complete before-and-after log.

## Tests

`uv run pytest` runs the test suite, including the copy checks in core/tests/test_copy.py. It needs `SESSION_SECRET` and a `DATABASE_URL` whose PostgreSQL user can create the test database. CI runs the same checks and tests on PostgreSQL 17 for every push (.github/workflows/ci.yml).

## Repository layout

- core/: models, migrations, forms, services, views and tests
- valo/: Django settings, routes and WSGI entry point
- templates/ and static/: server-rendered interface
- docs/content/: content guide, copy inventory and copy review
- RELEASE_SCOPE.md: known limitations and launch requirements

This repository is a source snapshot of the Valo Pay app from the Replit workspace, with the Django app at the repository root. Unrelated starter apps, uploaded business documents, generated files, databases and secrets are excluded. It is not an automatic sync of the workspace or its Git history.
