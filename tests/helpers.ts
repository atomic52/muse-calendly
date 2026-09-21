import { loadConfig, type AppConfig } from "../src/config.js";
import type { FetchLike } from "../src/calendly/types.js";

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    TOKEN_ENCRYPTION_KEY: "11".repeat(32),
    STORE_KIND: "memory",
    BRIDGE_PUBLIC_URL: "http://bridge.test",
    CALENDLY_CLIENT_ID: "client-123",
    CALENDLY_CLIENT_SECRET: "secret-456",
    CALENDLY_REDIRECT_URI: "http://bridge.test/oauth/calendly/callback",
    CALENDLY_AUTH_BASE_URL: "https://auth.test",
    CALENDLY_API_BASE_URL: "https://api.test",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export interface RecordedCall {
  method: string;
  url: string;
  body?: unknown;
}

export interface FakeCalendly {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
  state: {
    tokenRequests: number;
    inviteeCreates: number;
    invalidGrant: boolean;
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function makeFakeCalendly(): FakeCalendly {
  const calls: RecordedCall[] = [];
  const state = { tokenRequests: 0, inviteeCreates: 0, invalidGrant: false };

  const fetchImpl: FetchLike = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    let body: unknown;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }
    calls.push({ method, url, body });

    if (url.endsWith("/oauth/token")) {
      state.tokenRequests += 1;
      if (state.invalidGrant) {
        return json({ error: "invalid_grant", error_description: "refresh token used" }, 400);
      }
      return json({
        token_type: "Bearer",
        access_token: `access-${state.tokenRequests}`,
        refresh_token: `refresh-${state.tokenRequests}`,
        created_at: 0,
        expires_in: 3600,
        owner: "https://api.test/users/U1",
        organization: "https://api.test/organizations/O1",
      });
    }

    if (url.includes("/users/me")) {
      return json({
        resource: {
          uri: "https://api.test/users/U1",
          name: "Ada Lovelace",
          email: "ada@example.com",
          timezone: "Europe/London",
          scheduling_url: "https://calendly.com/ada",
          current_organization: "https://api.test/organizations/O1",
        },
      });
    }

    if (url.includes("/event_types") && method === "GET") {
      return json({
        collection: [
          {
            uri: "https://api.test/event_types/ET1",
            name: "Intro call",
            slug: "intro",
            duration: 30,
            active: true,
            kind: "solo",
            scheduling_url: "https://calendly.com/ada/intro",
          },
        ],
        pagination: { count: 1, next_page: null },
      });
    }

    if (url.includes("/event_type_available_times")) {
      return json({
        collection: [
          {
            start_time: "2026-10-01T15:00:00Z",
            status: "available",
            invitees_remaining: 1,
            scheduling_url: "https://calendly.com/ada/intro",
          },
        ],
      });
    }

    if (url.endsWith("/invitees") && method === "POST") {
      state.inviteeCreates += 1;
      const startTime = (body as { start_time?: string } | undefined)?.start_time;
      return json(
        {
          resource: {
            uri: "https://api.test/invitees/I1",
            event: "https://api.test/scheduled_events/E1",
            status: "active",
            start_time: startTime,
            end_time: startTime,
            cancel_url: "https://calendly.com/cancellations/X",
            reschedule_url: "https://calendly.com/reschedulings/X",
          },
        },
        201,
      );
    }

    if (url.includes("/scheduled_events/") && url.endsWith("/cancellation") && method === "POST") {
      return new Response(null, { status: 204 });
    }

    if (url.includes("/scheduling_links") && method === "POST") {
      return json(
        {
          resource: {
            booking_url: "https://calendly.com/ada/intro?x=1",
            owner: "https://api.test/event_types/ET1",
            owner_type: "EventType",
          },
        },
        201,
      );
    }

    return json({ message: `unhandled ${method} ${url}` }, 404);
  };

  return { fetchImpl, calls, state };
}
