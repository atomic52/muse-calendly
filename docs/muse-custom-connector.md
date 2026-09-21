# Calendly Custom Connector for Meta Muse

Zero-code path: point Muse at a public OpenAPI spec and a Calendly Personal
Access Token (PAT). No bridge service required for the first experiment.

Status note (2026-09-21): Meta publishes no connector SDK, schema, or developer
terms. Custom connectors are built by Muse per user and are not reviewed by
Meta. Treat the Muse side as volatile.

---

## 1. Create a Calendly PAT

1. Log in to Calendly.
2. Go to **Integrations -> API & Webhooks**:
   <https://calendly.com/integrations/api_webhooks>
3. Create a token and select **only** these scopes:
   - `users:read`
   - `event_types:read`
   - `availability:read`
   - `scheduled_events:read`
4. Copy the token. Calendly does not store or show it again.

Put the token in a local `.env` (never in git) and run the smoke test first:

```bash
cp .env.example .env   # paste your PAT into CALENDLY_TOKEN
npm install
npm run smoke
```

Expected: `GET /users/me`, `GET /event_types`, and
`GET /event_type_available_times` all return `PASS`.

- `401` -> token invalid or revoked.
- `403` -> missing scope.
- `POST /invitees` (booking) requires a **paid Calendly plan**; reads work before
  that is available.

### Optional: provider booking test (writes)

Once a paid plan is available, exercise `POST /invitees` end to end. It is
opt-in and self-cleaning by default:

```bash
# 1. Set CALENDLY_INVITEE_EMAIL (and optionally LOCATION_KIND / EVENT_TYPE_URI)
# 2. Book the first open slot, then immediately cancel it
npm run smoke:book

# Or leave the booking in place for inspection:
npm run smoke -- --book
```

Flags and env:

| Flag / env | Effect |
|---|---|
| `--book` | Enables the write path (required) |
| `--cancel-after` | Cancels the created booking immediately |
| `--event-type=<uri>` / `CALENDLY_EVENT_TYPE_URI` | Pin an event type |
| `--start-time=<iso>` | Book a specific UTC slot instead of the first open one |
| `--location-kind=<kind>` / `CALENDLY_LOCATION_KIND` | Location (needed if the event type enforces one) |
| `CALENDLY_INVITEE_EMAIL` | Required for booking |

Booking is **not idempotent**; run it once at a time and confirm no duplicate
meetings remain.

This smoke test calls Calendly directly for provider verification. The curated
PAT connector spec below is read-only and does not expose these write operations.
Use the connector bridge for Muse booking, cancellation, and scheduling links.

---

## 2. Experiment A - point Muse at Calendly's public spec

Use the **real** spec URL. Do not use `developer.calendly.com/openapi.json`,
which is an HTML index page, not the spec.

- JSON: <https://developer.calendly.com/openapi/calendly-api.json>
- YAML: <https://developer.calendly.com/openapi/calendly-api.yaml>

Paste this into the Muse chat:

```text
Build a custom connector for Calendly.

The OpenAPI spec is at https://developer.calendly.com/openapi/calendly-api.json
It is public, so read it without logging in.

Auth is the header "Authorization: Bearer <token>". I will paste a Calendly
Personal Access Token into the secure credential prompt and never into this chat.

Do not book, cancel, reschedule, or modify anything yet. First call GET /users/me,
then GET /event_types using my organization URI from that response. Then list the
read-only operations you found and wait for my instruction.

If the spec asks for OAuth instead of a bearer token, stop and tell me before
doing anything else.
```

### Known catch: OAuth vs PAT

Calendly's public spec declares two `http` bearer schemes, but **62 of 63
operations are tagged `oauth2`**. Only `GET /event_type_memberships` is tagged
`personal_access_token`. Muse reads per-operation `security`, so it may reject a
plain PAT on most endpoints. If Experiment A stalls on auth, use Experiment B.

---

## 3. Experiment B - curated PAT-only spec (recommended)

Build a trimmed spec that keeps only the safe scheduling surface and forces the
PAT scheme:

```bash
npm run build:spec
# -> spec/curated-calendly.openapi.json
```

Then host it publicly (Muse fetches it from its own VM with no auth) and use its
raw URL. Easiest option: commit the file to a public GitHub repo and reference
`https://raw.githubusercontent.com/<you>/<repo>/<branch>/spec/curated-calendly.openapi.json`.

Paste this into Muse:

```text
Build a custom connector for Calendly.

The OpenAPI spec is at <paste the raw URL to spec/curated-calendly.openapi.json>
It is public, so read it without logging in. Every operation uses the
personal_access_token bearer scheme.

Auth is the header "Authorization: Bearer <token>". I will paste a Calendly
Personal Access Token into the secure credential prompt and never into this chat.

Do not book, cancel, or modify anything yet. First call GET /users/me, then
GET /event_types using my organization URI from that response. Then list the
operations you found and wait for my instruction.
```

The curated spec exposes:

| Operation | Purpose |
|---|---|
| `GET /users/me`, `GET /users/{uuid}` | identify the account and org |
| `GET /event_types`, `GET /event_types/{uuid}` | map intent to a meeting type |
| `GET /event_type_available_times` | propose slots (<= 31-day window) |
| `GET /event_type_memberships` | hosts for an event type |
| `GET /scheduled_events`, `GET /scheduled_events/{uuid}` | upcoming meetings |
| `GET /scheduled_events/{uuid}/invitees` | meeting attendees |
| `GET /locations`, availability, busy times | scheduling context |

Everything else (booking, cancellation, links, contacts, organizations, notetaker, routing, data compliance,
webhooks) is excluded on purpose.

---

## 4. Guardrails to keep while testing

- Keep Muse approvals on **"Ask for some actions"** or **"Always ask"**. Booking
  and cancellation are writes; leave them gated.
- Never paste the PAT into chat. Use the secure credential prompt only.
- The direct PAT spec is read-only. The bridge owns booking and supplies
  idempotency, audit, and rate-limit controls for writes.
- Calendly create-invitee limits: 10/min, 50/hr, 100/day (paid non-enterprise).
- Refresh tokens are irrelevant for PATs, but PATs can be revoked; the smoke test
  is your revocation check.

## 5. When to graduate to the bridge (Phase 2, built)

The zero-code path uses a personal token for one account. Move to the bridge
([`docs/bridge.md`](bridge.md)) when you need: OAuth for other users, idempotent
booking, rotating-refresh handling, per-user rate limits, audit trails, or a
directory submission.

With the bridge, Muse instead points at the bridge's own spec
(`${BRIDGE_PUBLIC_URL}/openapi.json`) and uses a connector key issued at the end
of the connect flow.
