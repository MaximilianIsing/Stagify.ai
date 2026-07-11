# Stagify.ai

AI-powered virtual staging and interior design for real estate. Upload a photo of an
empty or dated room and get a professionally staged result in about eight seconds —
plus an **AI Designer** (chat-to-stage, and CAD/PDF floor plans → photorealistic 3D
renders) and a **Masking Studio** for pixel-precise edits.

Node/Express monolith (`server.js`) serving a no-build static frontend (`public/`) and
a JSON API from one origin. State is a SQLite file plus flat JSON/CSV on a persistent
disk — no external database.

## Quick start

```bash
npm install

# Minimal config — staging needs a Gemini key (see the env doc for the rest):
echo "GOOGLE_AI_API_KEY=your_key_here" > .env

npm start        # → http://localhost:3000
```

Other scripts: `npm run dev` (auto-restart), `npm test` (unit suite; gates deploys),
`npm run test:e2e` (Playwright browser smokes), `npm run lint`.

## Documentation

Everything lives in [`docs/`](docs/README.md) — start there. Highlights:

- [`docs/README.md`](docs/README.md) — project overview, setup, layout, known limitations.
- [`docs/guides/architecture.md`](docs/guides/architecture.md) — how the server is structured (composition root, `routes/` + `lib/`).
- [`docs/guides/security.md`](docs/guides/security.md) — auth model, DoS/request-size hardening, rate limits.
- [`docs/guides/testing.md`](docs/guides/testing.md) — the test suite and how it gates deployment.
- [`docs/reference/endpoints.md`](docs/reference/endpoints.md) — HTTP API reference.
- [`docs/reference/environment-variables.md`](docs/reference/environment-variables.md) — every env var, with a copy-paste `.env`.
- [`docs/reference/data-stores.md`](docs/reference/data-stores.md) — the SQLite / JSON / CSV files and where they live.
- [`docs/operations/deployment.md`](docs/operations/deployment.md) — deploy runbook (Render, staging vs prod, backups, rollback).

## Deploying

Hosted on **Render**; the build runs `npm install && npm test`, so a failing test
blocks the deploy. **Auto-deploy is off** — pushing does not release; deploys are
triggered manually from the Render dashboard. See the
[deployment runbook](docs/operations/deployment.md).

## Requirements

Node.js ≥ 22.8.0. API keys are optional except **Gemini** (`GOOGLE_AI_API_KEY`) for the
core staging flow; every other integration degrades gracefully when unconfigured.
