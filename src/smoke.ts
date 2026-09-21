import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { isoRangeDays } from "./smokeWindow.js";

type Json = Record<string, unknown>;

const BASE_URL = (process.env.CALENDLY_BASE_URL ?? "https://api.calendly.com").replace(/\/$/, "");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--") && !a.includes("=")));
const opts = Object.fromEntries(
  args
    .filter((a) => a.startsWith("--") && a.includes("="))
    .map((a) => {
      const i = a.indexOf("=");
      return [a.slice(2, i), a.slice(i + 1)];
    }),
);

const SHOULD_BOOK = flags.has("--book");
const CANCEL_AFTER = flags.has("--cancel-after");

function loadDotEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

interface CallResult {
  label: string;
  method: string;
  url: string;
  status: number;
  ok: boolean;
  ms: number;
  data: unknown;
  hint?: string;
}

const results: CallResult[] = [];

function hintFor(status: number): string | undefined {
  switch (status) {
    case 400:
      return "Validation error. Check required fields (e.g. event type location).";
    case 401:
      return "Token missing, invalid, or revoked. Regenerate a PAT.";
    case 403:
      return "Token lacks the required scope for this endpoint.";
    case 404:
      return "Resource not found (bad UUID or not visible to this token).";
    case 409:
      return "Conflict (e.g. slot no longer available). Re-query availability.";
    case 429:
      return "Rate limited. Back off and retry after X-RateLimit-Reset seconds.";
    default:
      if (status >= 500) return "Calendly transient error. Retry with backoff.";
      return undefined;
  }
}

interface CallInit {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
}

async function call(
  label: string,
  pathOrUrl: string,
  token: string,
  init: CallInit = {},
): Promise<CallResult> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE_URL}${pathOrUrl}`;
  const method = init.method ?? "GET";
  const started = performance.now();
  let status = 0;
  let ok = false;
  let data: unknown = null;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    status = res.status;
    ok = res.ok;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
  } catch (err) {
    data = { error: err instanceof Error ? err.message : String(err) };
  }
  const ms = Math.round(performance.now() - started);
  const result: CallResult = {
    label,
    method,
    url,
    status,
    ok,
    ms,
    data,
    hint: hintFor(status),
  };
  results.push(result);
  const marker = ok ? "PASS" : "FAIL";
  console.log(`[${marker}] ${label} -> ${status} (${ms}ms)`);
  if (!ok) {
    if (result.hint) console.log(`       hint: ${result.hint}`);
    console.log(`       body: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return result;
}

function get(obj: unknown, key: string): unknown {
  if (obj && typeof obj === "object" && key in (obj as Json)) return (obj as Json)[key];
  return undefined;
}

function lastPathSegment(uri: string): string {
  return uri.split("/").filter(Boolean).pop() ?? "";
}

async function main(): Promise<void> {
  loadDotEnv();
  const token = process.env.CALENDLY_TOKEN?.trim();
  if (!token) {
    console.error("Missing CALENDLY_TOKEN. Copy .env.example to .env and add your PAT.");
    process.exit(2);
  }

  console.log(`Calendly base URL: ${BASE_URL}`);
  if (SHOULD_BOOK) {
    console.log("Mode: BOOK (writes enabled). This creates a real meeting.");
    if (CANCEL_AFTER) console.log("       --cancel-after: booking will be cancelled immediately.");
  } else {
    console.log("Mode: read-only (no bookings). Use --book to enable a write test.");
  }
  console.log("");

  const me = await call("GET /users/me", "/users/me", token);
  if (!me.ok) return finish();

  const resource = get(me.data, "resource") as Json | undefined;
  const userUri = resource?.uri as string | undefined;
  const organizationUri = resource?.current_organization as string | undefined;
  if (resource) {
    console.log(
      `       user: ${resource.name ?? "?"} <${resource.email ?? "?"}> tz=${
        resource.timezone ?? "?"
      }`,
    );
  }
  if (!organizationUri) {
    console.log("       could not read current_organization; skipping dependent calls.");
    return finish();
  }

  const eventTypesUrl = `/event_types?organization=${encodeURIComponent(
    organizationUri,
  )}&user=${encodeURIComponent(userUri ?? "")}&active=true&count=100`;
  const eventTypes = await call("GET /event_types", eventTypesUrl, token);
  if (!eventTypes.ok) return finish();

  const collection = (get(eventTypes.data, "collection") as Json[] | undefined) ?? [];
  console.log(`       found ${collection.length} active event type(s)`);

  const overrideUri = opts["event-type"] ?? process.env.CALENDLY_EVENT_TYPE_URI;
  const first =
    (overrideUri ? collection.find((e) => e.uri === overrideUri) : undefined) ?? collection[0];
  const firstUri = first?.uri as string | undefined;
  if (!firstUri) {
    console.log("       no event types available; create one in Calendly first.");
    return finish();
  }
  console.log(`       using: ${first?.name ?? "?"} (${first?.duration ?? "?"} min)`);

  const { start, end } = isoRangeDays(7);
  const availabilityUrl =
    `/event_type_available_times?event_type=${encodeURIComponent(firstUri)}` +
    `&start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}`;
  const availability = await call("GET /event_type_available_times", availabilityUrl, token);
  const slots = availability.ok
    ? ((get(availability.data, "collection") as Json[] | undefined) ?? [])
    : [];
  const openSlots = slots.filter((s) => s.status === "available");
  if (availability.ok) {
    console.log(`       ${openSlots.length} open slot(s) in the next 7 days`);
    for (const slot of openSlots.slice(0, 5)) console.log(`         - ${String(slot.start_time)}`);
  }

  if (SHOULD_BOOK) await bookFlow(token, firstUri, openSlots);

  finish();
}

async function bookFlow(token: string, eventTypeUri: string, openSlots: Json[]): Promise<void> {
  console.log("\n-- booking test --");
  const email = process.env.CALENDLY_INVITEE_EMAIL?.trim();
  if (!email) {
    console.log("[SKIP] POST /invitees -> CALENDLY_INVITEE_EMAIL is required for --book");
    return;
  }
  const startTime = opts["start-time"] ?? (openSlots[0]?.start_time as string | undefined);
  if (!startTime) {
    console.log("[SKIP] POST /invitees -> no available slot to book");
    return;
  }

  const name = process.env.CALENDLY_INVITEE_NAME?.trim() ?? "Muse Connector Test";
  const timezone = process.env.CALENDLY_INVITEE_TIMEZONE?.trim() ?? "America/New_York";
  const locationKind = opts["location-kind"] ?? process.env.CALENDLY_LOCATION_KIND;

  const body: Json = {
    event_type: eventTypeUri,
    start_time: startTime,
    invitee: { name, email, timezone },
  };
  if (locationKind) body.location = { kind: locationKind };

  console.log(`       booking ${startTime} for ${name} <${email}> tz=${timezone}`);
  const booking = await call("POST /invitees", "/invitees", token, { method: "POST", body });
  if (!booking.ok) {
    console.log("       booking failed; no cleanup needed.");
    return;
  }

  const booked = get(booking.data, "resource") as Json | undefined;
  const eventUri = booked?.uri as string | undefined;
  const eventUuid = eventUri ? lastPathSegment(eventUri) : undefined;
  console.log(`       booked event: ${eventUri ?? "?"}`);
  if (booked?.cancel_url) console.log(`       cancel: ${String(booked.cancel_url)}`);
  if (booked?.reschedule_url) console.log(`       reschedule: ${String(booked.reschedule_url)}`);

  if (!CANCEL_AFTER) {
    console.log("       leaving booking in place (use --cancel-after to clean up).");
    return;
  }
  if (!eventUuid) {
    console.log("       cannot cancel: no event UUID in response.");
    return;
  }
  const reason = process.env.CALENDLY_CANCEL_REASON?.trim() ?? "Muse connector smoke test";
  await call(
    `POST /scheduled_events/${eventUuid}/cancellation`,
    `/scheduled_events/${eventUuid}/cancellation`,
    token,
    { method: "POST", body: { reason } },
  );
}

function finish(): never {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} calls passed.`);
  if (failed.length) {
    console.log("Failed calls:");
    for (const f of failed) console.log(`  - ${f.label} (${f.status}) ${f.hint ?? ""}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
