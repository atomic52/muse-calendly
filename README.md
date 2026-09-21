# muse-calendly

Calendly custom connector for Meta's Muse agent.

Phase 1 (this repo state): a **zero-code experiment** - hand Muse a public
OpenAPI spec plus a Calendly Personal Access Token, no server required.

## Quick start

```bash
npm install
cp .env.example .env      # add CALENDLY_TOKEN
npm run smoke             # read-only: users/me, event types, availability
npm run smoke:book        # opt-in write test: book + immediate cancel (paid plan)
npm run build:spec        # build the curated PAT-only spec (fallback)
npm run typecheck
```

Then follow [`docs/muse-custom-connector.md`](docs/muse-custom-connector.md).

## Layout

| Path | Purpose |
|---|---|
| `src/smoke.ts` | Read-only PAT smoke test (`GET /users/me`, event types, availability) |
| `src/build-spec.ts` | Trims the public spec to a PAT-only scheduling surface |
| `spec/curated-calendly.openapi.json` | Generated spec to host publicly for Muse |
| `docs/muse-custom-connector.md` | Paste-ready Muse briefs + guardrails |

## Important

- Muse has **no published connector SDK, schema, or developer terms** as of
  2026-09-21. Custom connectors are built per user by Muse and are not reviewed.
- Calendly's public spec tags 62/63 operations as `oauth2`; the curated spec
  forces the `personal_access_token` bearer scheme instead.
- `POST /invitees` (booking) requires a paid Calendly plan and is rate limited.
  Reads work without it.
