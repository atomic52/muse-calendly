import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Builds a curated, PAT-only Calendly OpenAPI document for the Muse custom
 * connector.
 *
 * Why: Calendly's public spec marks 62 of 63 operations as `oauth2`, even though
 * it also declares a `personal_access_token` bearer scheme. Muse custom
 * connectors handle bearer tokens directly, so this script trims the spec to a
 * safe scheduling surface and forces the PAT scheme.
 */

const SOURCE_URL =
  process.env.CALENDLY_SPEC_URL ?? "https://developer.calendly.com/openapi/calendly-api.json";
const OUT_PATH = resolve(process.cwd(), process.env.OUT_SPEC ?? "spec/curated-calendly.openapi.json");

const ALLOWED: Record<string, string[]> = {
  "/users/me": ["get"],
  "/users/{uuid}": ["get"],
  "/event_types": ["get"],
  "/event_types/{uuid}": ["get"],
  "/event_type_available_times": ["get"],
  "/event_type_memberships": ["get"],
  "/scheduled_events": ["get"],
  "/scheduled_events/{uuid}": ["get"],
  "/scheduled_events/{uuid}/invitees": ["get"],
  "/scheduled_events/{event_uuid}/invitees/{invitee_uuid}": ["get"],
  "/locations": ["get"],
  "/user_availability_schedules": ["get"],
  "/user_availability_schedules/{uuid}": ["get"],
  "/user_busy_times": ["get"],
};

const DESCRIPTION = [
  "Curated Calendly API surface for a Meta Muse custom connector.",
  "",
  "Authentication: send `Authorization: Bearer <Calendly Personal Access Token>`.",
  "All operations below use the `personal_access_token` scheme.",
  "",
  "Safe usage for agents:",
  "- Read first: resolve event types, then availability, then confirm with the user before any write.",
  "- This direct PAT surface is read-only; use the connector bridge for writes.",
  "- Send `start_time`/`end_time` as UTC ISO-8601 with a trailing Z.",
  "- Availability windows cannot span more than 31 days per request.",
].join("\n");

type Method = "get" | "post" | "put" | "patch" | "delete";

interface OpenApiDoc {
  openapi: string;
  info: Record<string, unknown>;
  servers?: Array<Record<string, unknown>>;
  security?: Array<Record<string, unknown>>;
  tags?: Array<Record<string, unknown>>;
  paths: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
  [key: string]: unknown;
}

async function main(): Promise<void> {
  console.log(`Fetching source spec: ${SOURCE_URL}`);
  const res = await fetch(SOURCE_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Failed to fetch spec: HTTP ${res.status}`);
  }
  const source = (await res.json()) as OpenApiDoc;

  const keptPaths: Record<string, Record<string, unknown>> = {};
  let keptOps = 0;

  for (const [path, methods] of Object.entries(ALLOWED)) {
    const item = source.paths[path];
    if (!item) {
      console.warn(`  ! path not found in source, skipping: ${path}`);
      continue;
    }
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item)) {
      const lower = key.toLowerCase() as Method;
      if (methods.includes(lower)) {
        const op = { ...(value as Record<string, unknown>) };
        op.security = [{ personal_access_token: [] }];
        filtered[key] = op;
        keptOps += 1;
      } else if (["parameters", "summary", "description"].includes(key)) {
        filtered[key] = value;
      }
    }
    keptPaths[path] = filtered;
  }

  const usedTags = new Set<string>();
  for (const item of Object.values(keptPaths)) {
    for (const value of Object.values(item)) {
      const tags = (value as { tags?: string[] }).tags;
      if (tags) for (const t of tags) usedTags.add(t);
    }
  }

  const components = structuredClone(source.components ?? {});
  components.securitySchemes = {
    personal_access_token: {
      type: "http",
      scheme: "bearer",
      description: "Calendly Personal Access Token.",
    },
  };

  const output: OpenApiDoc = {
    openapi: source.openapi ?? "3.1.0",
    info: {
      title: "Calendly Connector (Muse, Personal Access Token)",
      version: (source.info?.version as string) ?? "1.0.0",
      description: DESCRIPTION,
    },
    servers: [{ url: "https://api.calendly.com", description: "Calendly API v2" }],
    security: [{ personal_access_token: [] }],
    tags: (source.tags ?? []).filter((t) => usedTags.has(t.name as string)),
    paths: keptPaths,
    components,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Wrote ${keptOps} operations across ${Object.keys(keptPaths).length} paths`);
  console.log(`Output: ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
