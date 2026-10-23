# EnergyTracker — local development

## Architecture

- Frontend: React, TypeScript, Vite.
- API: Express, TypeScript, Node.js 22.
- Database: PostgreSQL 17.
- Meter-photo evidence: private filesystem storage mounted into the API container; photo bytes are not stored in Git.
- OCR: Tesseract.js runs in the browser. OCR output is a suggestion only; the operator must verify the reading.
- Timezone default: Asia/Jakarta; currency default: IDR.

The local development stack is intended to move to the internal VM later. GitHub is the source repository, not the runtime database or photo store.

## Start the development stack

1. Copy `.env.example` to `.env`.
2. Replace all placeholder secrets with unique values. Never commit `.env`.
3. Run `docker compose up --build` from the repository root.
4. Check `http://localhost:3000/api/health` and open `http://localhost:5173`.

PostgreSQL is on the internal Compose network and is not published to the host. Docker's `/docker-entrypoint-initdb.d` scripts run only when the database volume is initialized for the first time.

### Apply a later migration to an existing development database

Do not delete the PostgreSQL volume just to apply a migration. For migration 003, run this from a Bash-compatible terminal at the repository root:

```bash
docker compose exec -T db psql -U energytracker -d energytracker -v ON_ERROR_STOP=1 < server/migrations/003_schema_alignment.sql
```

In PowerShell, use:

```powershell
Get-Content .\server\migrations\003_schema_alignment.sql -Raw | docker compose exec -T db psql -U energytracker -d energytracker -v ON_ERROR_STOP=1
```

Migration 003 adds columns required by current API queries. It is safe to re-run. For a fresh database, numbered migrations are applied in filename order during initial database setup.

## Create the first administrator

The bootstrap endpoint is available only when `BOOTSTRAP_ADMIN_TOKEN` is configured and no users exist. Send a one-time request to `POST /api/auth/bootstrap` with JSON fields `token`, `username`, `displayName`, and `password`. Use a password of at least 12 characters and send the request only from a trusted local environment.

Example body:

```json
{
  "token": "the-token-from-your-local-env-file",
  "username": "engineering.admin",
  "displayName": "Engineering Administrator",
  "password": "replace-with-a-unique-long-password"
}
```

After the first administrator is created, remove `BOOTSTRAP_ADMIN_TOKEN` from `.env` and restart the API. Bootstrap closes itself once any user exists. Sign-in uses an opaque server-side session, stored as a hash in PostgreSQL and sent through an HttpOnly, SameSite=Lax cookie. Production must use HTTPS so the cookie is Secure.

## Implemented foundations

- Authentication, role checks, server-side sessions, and login rate limiting.
- Meter register and effective-dated utility-rate configuration endpoints/UI.
- Meter-reading submission with photo validation, private file storage, SHA-256 evidence hash, duplicate-date protection, baseline handling, consumption/cost snapshots, and audit logging.
- Browser-local Tesseract.js OCR; OCR results must be checked manually.
- Shift-checklist API for loading active templates/shifts/items, submitting responses, viewing submissions, and supervisor/admin review.
- CI builds and TypeScript checks for frontend and API.

## Current limitations

- Checklist templates, checklist items, and shift definitions must be configured in PostgreSQL before the checklist UI can accept submissions. An administrator-facing checklist-configuration screen is not implemented yet.
- Photo-type checklist responses are deliberately rejected until their private upload workflow is implemented.
- The dashboard charts and KPI tiles are illustrative demo data, not yet derived from stored readings.
- Full end-to-end integration testing against a running Compose/PostgreSQL instance and deployment to the internal VM have not yet been completed.
- Invoice OCR/review, budget management, payment reconciliation, and export/reporting remain future modules.

Never place hotel invoices, meter photos, passwords, database dumps, or production records in this repository. Keep private documents in the eventual VM storage volume. Do not use the app for operational hotel data until runtime, authorization, backup/restore, and security testing are completed.
