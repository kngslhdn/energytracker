# Local development notes

## Start the development stack

1. Copy `.env.example` to `.env` and replace all placeholder values. Use a unique random `POSTGRES_PASSWORD` and `BOOTSTRAP_ADMIN_TOKEN`.
2. Run `docker compose up --build` from the repository root.
3. Check `http://localhost:3000/api/health` and open `http://localhost:5173`.

PostgreSQL is on an internal Compose network and is not published to the host. The initial SQL migrations are applied only when PostgreSQL initializes a new data volume. Do not delete the volume to apply a later migration; apply migrations deliberately.

## Create the first administrator

The bootstrap endpoint is available only when `BOOTSTRAP_ADMIN_TOKEN` is configured and no users exist. Send a one-time request to `POST /api/auth/bootstrap` with JSON fields `token`, `username`, `displayName`, and `password`. Use a password of at least 12 characters and send the request only from a trusted local environment. Example body:

```json
{
  "token": "the-token-from-your-local-env-file",
  "username": "engineering.admin",
  "displayName": "Engineering Administrator",
  "password": "replace-with-a-unique-long-password"
}
```

After the first administrator is created, remove `BOOTSTRAP_ADMIN_TOKEN` from `.env` and restart the API. Bootstrap closes itself once any user exists. Sign-in uses an opaque server-side session, stored as a hash in PostgreSQL and sent through an HttpOnly, SameSite=Lax cookie. Production must use HTTPS so the cookie is Secure.

## Current implementation boundaries

The API currently includes health, meter-list, bootstrap, login, current-session, and logout endpoints. The frontend includes the dashboard preview and local browser OCR for a meter photo. The meter-reading form deliberately does not claim to save: the authenticated reading-creation endpoint, private evidence storage, meter/rate configuration UI, and full login integration are still to be implemented. Dashboard numbers are labelled demo data and are not connected to real meter readings.

Never place hotel invoices, meter photos, passwords, database dumps, or production records in this public repository. Keep private documents in the eventual VM storage volume.
