# Valo Pay

Collections and Pay-by-bank software for Nigerian lenders and cooperatives. This repository mirrors the Replit workspace: the Django app is in [`artifacts/valo-pay/`](artifacts/valo-pay/).

**Demo with sample data only: not production-ready.** No real payments or messages are sent. Never enter real customer data.

## Layout

- `artifacts/valo-pay/`: the Django app as it runs on Replit (`core/`, `valo/`, `templates/`, `static/`, `manage.py`)
- `pyproject.toml`, `uv.lock`: Python dependencies, as locked in the Replit workspace
- `docs/github-copy-2026-10/`: documents for the earlier GitHub copy of the app, kept for reference

## Run the tests

```sh
uv sync --locked
cd artifacts/valo-pay
export SESSION_SECRET="<a long random test-only value>"
export DATABASE_URL="postgres://<user>@<host>/<database>"
uv run python manage.py test
```

The browser tests also need Playwright's Chromium (`uv run python -m playwright install chromium`) and axe-core in `node_modules/` at the repository root (`npm install --no-save axe-core@4`). CI runs all of this on PostgreSQL 16 for every push (`.github/workflows/ci.yml`).

## Keeping GitHub and Replit in step

The app runs on Replit, and this repository is not synced automatically. Before working in one place, bring over what changed in the other:

- **Replit to GitHub:** ask Replit Agent to push the workspace's `artifacts/valo-pay/` to a new branch of this repository, then open a pull request.
- **GitHub to Replit:** ask Replit Agent to fetch `main` and apply the changes under `artifacts/valo-pay/` to the workspace, then restart the app and run its tests.

Until 5 October 2026 this repository held a separate copy of the app at the repository root, which is why changes merged here did not appear on Replit. See `docs/github-copy-2026-10/`.
