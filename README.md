# Cloud Drive — Backend

Express 5 + TypeScript REST API for Cloud Drive, owning session authentication, folder and file metadata, atomic storage quotas, inherited permissions, streaming S3/MinIO object I/O, and automated Docker VPS releases.

- **Live App:** [cloud.dhpham.dev](https://cloud.dhpham.dev)
- **Public Boards (no sign-in required):** [cloud.dhpham.dev/explore](https://cloud.dhpham.dev/explore)
- **Frontend Repository:** [DHPh/project-cloud-drive-fe](https://github.com/DHPh/project-cloud-drive-fe)

## Architecture & Capabilities

- **Stack:** Node.js 24, Express 5, TypeScript, TypeORM, PostgreSQL 17, MinIO (`@aws-sdk/client-s3`), Zod, Busboy, `zip-stream`.
- **Security & Sessions:** `HttpOnly` cookie sessions stored as SHA-256 hashes in PostgreSQL, same-origin CSRF checks validated against comma-separated `APP_ORIGIN`, optional `TRUSTED_PROXY_RANGES` for reverse-proxy IP sanitization, invite-based user onboarding, and one-time admin bootstrap CLI (`dist/bootstrap-admin.js`).
- **Storage & Streaming:** Streaming multipart uploads (`busboy`) and streaming ZIP downloads (`zip-stream`) backed by private unversioned MinIO buckets, atomic quota accounting, Trash lifecycle management, and storage reconciliation (`npm run storage:reconcile`).
- **CI/CD:** GitHub Actions runs PostgreSQL 17 integration tests, builds the production Docker image, deploys and activates it over SSH on the Linux VPS, and verifies `GET /health`.

## Documentation

- [Backend Design](docs/design.md)
- [API Contracts](docs/contracts/README.md) · [OpenAPI Spec](docs/contracts/openapi.yaml)
- [Verification & Handover](docs/verification.md)
- [Docker CI/CD to VPS](docs/deploy-vps.md)
- [Operations, Backup & Reconciliation Runbook](docs/operations.md)

## Local Development

Requires **Node.js 24** (`>=24 <25`) and **Docker Compose**. Copy [.env.example](.env.example) to `.env`, then start local infrastructure and the API:

```sh
npm ci
npm run infra:up
npm run db:setup
npm run dev
```

Default local endpoints and ports:
- **API:** `http://127.0.0.1:3001` (serves `/api/v1` and `GET /health`)
- **Frontend:** `http://127.0.0.1:3000`
- **PostgreSQL 17:** port `55432`
- **MinIO:** port `59000`

`npm run db:setup` applies migrations and seeds synthetic fixtures, creating `demo@example.test` and `viewer@example.test` with the default password `CloudDrive-Demo-2025!` (overridable via `DEMO_PASSWORD` before the first seed). For admin Playwright flows, build first and bootstrap a test admin matching `PLAYWRIGHT_ADMIN_EMAIL` and `PLAYWRIGHT_ADMIN_PASSWORD`:

```sh
npm run build
BOOTSTRAP_ADMIN_EMAIL=admin@example.test BOOTSTRAP_ADMIN_NAME="Admin" BOOTSTRAP_ADMIN_PASSWORD="..." node dist/bootstrap-admin.js
```

Run `npm run infra:down` to stop local containers while preserving `cloud-drive-backend-dev` volumes.

## Maintained Scripts

| Script | Purpose |
| --- | --- |
| `npm run infra:up` | Start local PostgreSQL and MinIO containers via Docker Compose |
| `npm run infra:down` | Stop local containers while retaining persistent volumes |
| `npm run dev` | Run the development API server with `tsx --watch` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Type-check source and test TypeScript configurations |
| `npm run start` | Run the compiled production server (`dist/main.js`) |
| `npm run db:migrate` | Run TypeORM database migrations |
| `npm run db:seed` | Seed synthetic development accounts and fixtures |
| `npm run db:setup` | Run migrations followed by development seeding |
| `npm run storage:reconcile` | Reconcile PostgreSQL metadata and MinIO object storage |
| `npm test` | Run backend integration and unit test suites |

## Production Deployment Notes

See [Docker CI/CD to VPS](docs/deploy-vps.md) and the [Operations, Backup & Reconciliation Runbook](docs/operations.md) for full setup and backup procedures.

- Set `NODE_ENV=production` and `APP_ORIGIN` to the exact allowed HTTPS frontend origin(s) (supports one or more comma-separated values). When the Vercel frontend proxies `/api/v1`, preserve both browser `Origin` and response `Set-Cookie` headers so session cookies bind to the frontend hostname.
- Provision PostgreSQL 17 and a private unversioned MinIO bucket with object delete permission (required for Trash purging). Run `node dist/cli.js migrate` once per release before `npm start`—do not run dev seeding in production.
- Behind a reverse proxy or tunnel, set `TRUSTED_PROXY_RANGES` to the verified proxy IP/CIDRs that sanitize forwarding headers.
- Create the initial admin account once with `node dist/bootstrap-admin.js` using environment-scoped `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_NAME`, and `BOOTSTRAP_ADMIN_PASSWORD`, verify login, then remove the bootstrap credentials and use single-use invites for additional accounts.
- Verify `GET /health` and end-to-end sign-in, upload, and download over the real frontend proxy origin after each rollout.
