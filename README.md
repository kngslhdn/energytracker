# Engineering Energy Tracker

Self-hostable Engineering utility monitoring for shift checklists, daily meter readings, photo OCR, budgets, supplier invoices, payments, and reconciliation.

## Stack
- React + TypeScript + Vite
- Node.js + TypeScript + Express API
- PostgreSQL 17 (the same database engine for development and VM deployment)
- Tesseract.js OCR in the browser; private source photos are not sent to third-party OCR services
- Docker Compose for local development and later VM deployment

## Status
Initial repository foundation is being implemented. Features are added incrementally; see the repository for current implementation and tests. Any demo data must be clearly labelled and must never be mistaken for hotel production data.

## Local development
1. Copy `.env.example` to `.env` and replace every placeholder secret.
2. Run `docker compose up --build`.
3. Open the frontend at `http://localhost:5173`; API health is available at `http://localhost:3000/api/health`.

PostgreSQL is not exposed to the host by default. Uploaded evidence must remain private and must not be committed to Git. For browser camera access, use localhost during development and HTTPS in deployment.

## Deployment principles
- Keep PostgreSQL, uploaded files, and secrets off GitHub.
- Use private persistent storage and encrypted backups on the VM.
- Apply SQL migrations in order; never reset or overwrite production data as a deployment shortcut.
- Set a strong unique `SESSION_SECRET`, restrict network access, and terminate TLS at Nginx or another trusted reverse proxy.
- Set `APP_ENV=production` and configure secure cookies before production use.

## Time, money, and readings
Operational dates use `Asia/Jakarta`. Monetary amounts and meter readings must use decimal-safe PostgreSQL `NUMERIC` values. A reading is unique per meter and operational date. Consumption is calculated server-side from the previous accepted reading, multiplier, and applicable effective-dated rate; the first reading is a baseline and has no invented consumption.
