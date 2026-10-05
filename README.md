# Valo Pay

Django 5.2 and PostgreSQL collections workspace for Nigerian lenders and cooperatives.
This standalone source export matches the safer Replit implementation. It is
**not a live payment service**: provider execution, real delivery and live onboarding
remain gated. Never enter real customer data in the synthetic demo.

## Features and access

- Dashboard with full-width Due today, customers with multiple loans, collections,
  payment requests, independent review, refund approval, CSV import/export and audit.
- Explicit synthetic demo at `/demo/`: choose **Start the demo** to create sample
  records. Ordinary visits do not seed data.
- Ten-step guide with Previous/Next/End controls and sample role switching.
- Sample debit simulation is restricted to eligible synthetic sessions. No bank is
  contacted and no automatic retries run.
- Staff sign-in at `/access/login/` is separate: membership, password and mandatory
  authenticator verification. There are no default staff credentials; first-account
  provisioning, delivery and recovery are still deployment gates, not a public signup.
- Demo inactivity ends the session after 30 minutes. Restart detaches the old
  workspace; it does not delete its records. No automatic purge is configured.

## Setup

Requires Python 3.12+, PostgreSQL and a trusted HTTPS reverse proxy.

1. Install locked dependencies with `uv sync --locked`.
2. Supply `DATABASE_URL` and a strong `SESSION_SECRET` through your runtime secret
   manager. Never put their values in Git.
3. Set `VALO_ALLOWED_HOSTS` to comma-separated exact hostnames, without schemes,
   ports or wildcards. Replit-provided domains are also supported.
4. **Only for a new, empty development database:** run
   `uv run python manage.py migrate`.
5. Run `uv run python manage.py collectstatic --noinput`.
6. Run `uv run python manage.py check`, then start
   `uv run gunicorn valo.wsgi:application --bind 0.0.0.0:8000`.

Development also supports `uv run python manage.py runserver 0.0.0.0:8000`.
Secure cookies require HTTPS for browser sessions; trust forwarded HTTPS headers
only from your controlled reverse proxy. CSRF remains same-origin.

**Existing database warning:** do not run migrations blindly against a database
created by the older GitHub demo. That version used a conflicting second migration
and different schema. Back up and review an explicit migration plan first. This PR
neither upgrades that database nor rewrites migration history. Replit's existing
database is not part of this export.

`bin/build` collects assets after configuration checks. `bin/serve` requires `PORT`
and runs a read-only schema check before Gunicorn; it never migrates or seeds.
Publishing remains a separate action.

## Checks

Use `uv run python manage.py check` and
`uv run python manage.py makemigrations --check --dry-run`.
CI runs the backend test modules against temporary PostgreSQL test databases.
It requires a database role with permission to create a test database.

Browser tests additionally require Chromium on PATH, Playwright and its system
libraries. Run them in an isolated test environment, for example:
`uv run python manage.py test core.test_demo_browser --noinput`.

## Layout

- `core/`, `valo/`, `manage.py`: application, migrations and tests.
- `templates/`, `static/`: server-rendered UI and bundled assets.
- `bin/`: guarded build/start scripts.
- `tests/`: additional smoke and visual-test helpers.
- `RELEASE_SCOPE.md`, `UI_CONTRACT.md`: current boundaries and interface contract.
- `docs/content/`: historical copy-review material from the older demo; it is not
  the current route, retention or security contract.

Only app source and necessary setup documentation are exported. Workspace metadata,
internal handovers, uploaded documents, evidence, databases and credentials are
excluded. GitHub history is preserved; this is not an automatic workspace sync.
