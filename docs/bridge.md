# Connector Bridge (Phase 2)

A small Node/TS service that sits between Muse and Calendly. Muse calls the
bridge with a **connector key**; the bridge handles Calendly OAuth, token
rotation, idempotency, rate limiting, and auditing.

Why a bridge instead of pointing Muse at Calendly directly:

- Calendly OAuth is OAuth-only for most endpoints; Muse custom connectors prefer
  a bearer token.
- Refresh tokens are **single-use and rotate**, so refreshes must be serialized
  server-side.
- `POST /invitees` is **not idempotent**, and agents retry. The bridge dedupes.
- Only a narrow, safe subset of Calendly should ever be exposed to an agent.

```
Muse VM ──bearer connector key──> Bridge ──OAuth 2.1 + PKCE──> auth.calendly.com
   ▲                                 │                      └─> api.calendly.com
   └──── GET /openapi.json ──────────┘
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | liveness + config check |
| GET | `/connect/calendly/start` | begin OAuth (redirects; `?format=json` for the URL) |
| GET | `/oauth/calendly/callback` | OAuth callback; shows the connector key once |
| GET | `/openapi.json` | the spec handed to Muse |
| GET | `/v1/me` | connected Calendly account |
| GET | `/v1/event-types` | bookable meeting types |
| GET | `/v1/event-types/{uuid}/availability` | open slots |
| GET/POST | `/v1/bookings` | list / create (idempotent) bookings |
| POST | `/v1/bookings/{uuid}/cancel` | cancel a meeting |
| POST | `/v1/scheduling-links` | single-use scheduling link |
| GET | `/v1/audit` | actions Muse has taken |

All `/v1/*` require `Authorization: Bearer <connector key>`.

## Run locally

```bash
cp .env.example .env
# set CALENDLY_CLIENT_ID / CALENDLY_CLIENT_SECRET (and TOKEN_ENCRYPTION_KEY)
npm install
npm run dev
```

Create the Calendly OAuth app at <https://developer.calendly.com> (web app,
redirect URI `http://localhost:8787/oauth/calendly/callback`, PKCE S256).
Then:

1. Open <http://localhost:8787/connect/calendly/start> and authorize.
2. The callback page shows the **connector key** once. Copy it.
3. In Muse: ask it to build a custom connector for Calendly, point it at
   `http://localhost:8787/openapi.json` (public URL in production), and paste the
   connector key into the secure credential prompt.

For a local Muse to reach the bridge, expose it (e.g. a tunnel) and set
`BRIDGE_PUBLIC_URL` / `CALENDLY_REDIRECT_URI` to that URL.

## Security model

- **Connector keys**: `cal_<prefix>_<secret>`; only the prefix and a sha256 of
  the secret are stored. The key is shown once, at the end of the connect flow.
- **OAuth setup sessions**: the short-lived authorization state is bound to an
  HttpOnly setup cookie and is deleted only after the code exchange succeeds.
- **Token storage**: Calendly access/refresh tokens are encrypted with
  AES-256-GCM using `TOKEN_ENCRYPTION_KEY`. Never logged.
- **Refresh rotation**: single-use refresh tokens are overwritten on every
  refresh; refreshes are serialized per connection. On `invalid_grant` the
  connection is marked `needs_reconnect` and the user must reconnect.
- **Idempotency**: `POST /v1/bookings` honors `Idempotency-Key`; without one it
  derives a key from the request fingerprint. Replays return the original result.
- **Write retry policy**: writes are never replayed automatically after a 401;
  booking retries must carry an `Idempotency-Key`.
- **Rate limiting**: per-connection fixed window (`RATE_LIMIT_PER_MINUTE`).
- **Audit**: every `/v1/*` call is recorded with actor, action, status, latency.
- **Least privilege**: request only the scopes you need when creating the OAuth
  app. Booking uses `scheduled_events:write`; drop it for read-only deployments.

## Tests

```bash
npm test        # 31 tests: crypto, token rotation, idempotency, connect, connector API
npm run typecheck
```

Tests use an in-memory store and a fake Calendly (`tests/helpers.ts`), so they
run with no network and no credentials.

## Production notes

- Replace the file store with Postgres/Redis; the `Store` interface
  (`src/store/types.ts`) is the seam. Keep refreshes serialized per connection
  (a distributed lock if you run multiple instances).
- `POST /invitees` requires a paid Calendly plan and is rate limited to
  10/min, 50/hr, 100/day on paid non-enterprise. Queue or back off accordingly.
- Dev dependency advisories exist in vitest/vite/esbuild (tests only); runtime
  dependencies report 0 vulnerabilities (`npm audit --omit=dev`).
