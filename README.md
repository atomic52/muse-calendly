# muse-calendly

Calendly connector for Meta's Muse agent.

- **Phase 1 — zero-code experiment**: hand Muse a public OpenAPI spec plus a
  Calendly Personal Access Token. No server required.
- **Phase 2 — OAuth bridge**: a Node/TS service that owns Calendly OAuth, token
  rotation, idempotent booking, rate limiting, and auditing, and exposes a narrow
  API for Muse to call with a connector key.

## Quick start

Phase 1 (reads work without a paid Calendly plan):

```bash
npm install
cp .env.example .env      # add CALENDLY_TOKEN
npm run smoke             # read-only: users/me, event types, availability
npm run smoke:book        # opt-in write test: book + immediate cancel (paid plan)
npm run build:spec        # curated PAT-only Calendly spec
```

Phase 2 (bridge):

```bash
npm run dev               # starts the bridge on :8787
npm run build:connector-spec
npm test                  # 27 tests, no network/credentials needed
npm run typecheck
```

See [`docs/bridge.md`](docs/bridge.md) for the OAuth setup and
[`docs/muse-custom-connector.md`](docs/muse-custom-connector.md) for the Muse
connector briefs.

## Layout

| Path | Purpose |
|---|---|
| `src/smoke.ts` | PAT smoke test (`--book` for the write path) |
| `src/build-spec.ts` | Trims Calendly's public spec to a PAT-only surface |
| `src/http/app.ts` | Bridge composition root |
| `src/http/routes/connector.ts` | `/v1/*` connector API for Muse |
| `src/http/routes/connect.ts` | OAuth connect + callback |
| `src/calendly/` | OAuth client, REST client, token manager |
| `src/services/` | connections, idempotency, rate limiting, audit |
| `src/connectorSpec.ts` | OpenAPI document served at `/openapi.json` |
| `spec/` | Generated specs (`curated-calendly`, `connector`) |
| `tests/` | Unit + route tests with a fake Calendly |

## Important

- Muse has **no published connector SDK, schema, or developer terms** as of
  2026-09-21. Custom connectors are built per user by Muse and are not reviewed.
- Calendly's public spec tags 62/63 operations as `oauth2`; the curated spec
  forces the `personal_access_token` bearer scheme instead.
- `POST /invitees` (booking) requires a paid Calendly plan and is rate limited.
  The bridge dedupes retries so agents don't create duplicate meetings.
