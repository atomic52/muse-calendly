import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app.js";
import { CalendlyOAuth } from "../src/calendly/oauth.js";
import { createStore } from "../src/store/store.js";
import { makeFakeCalendly, testConfig } from "./helpers.js";

async function setUpApp() {
  const fake = makeFakeCalendly();
  const config = testConfig();
  const store = createStore({ kind: "memory", path: "" });
  const app = buildApp({ config, store, fetchImpl: fake.fetchImpl, logger: false });
  return { fake, app, config };
}

async function connect(app: FastifyInstance): Promise<string> {
  const start = await app.inject({ method: "GET", url: "/connect/calendly/start?format=json" });
  expect(start.statusCode).toBe(200);
  const { state, authorizeUrl } = start.json();
  expect(authorizeUrl).toContain("code_challenge_method=S256");
  const setCookie = start.headers["set-cookie"];
  const cookieHeader = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
  expect(cookieHeader).toBeTruthy();

  const callback = await app.inject({
    method: "GET",
    url: `/oauth/calendly/callback?code=auth-code&state=${state}&format=json`,
    headers: { cookie: cookieHeader },
  });
  expect(callback.statusCode).toBe(200);
  return callback.json().connectorKey as string;
}

describe("connect flow", () => {
  it("exchanges the code and returns a connector key", async () => {
    const { app, fake } = await setUpApp();
    const key = await connect(app);
    expect(key).toMatch(/^cal_[0-9a-f]{12}_[0-9a-f]{48}$/);
    expect(fake.state.tokenRequests).toBe(1);
  });

  it("rejects reuse of the same state", async () => {
    const { app } = await setUpApp();
    const start = await app.inject({ method: "GET", url: "/connect/calendly/start?format=json" });
    const { state } = start.json();
    await app.inject({
      method: "GET",
      url: `/oauth/calendly/callback?code=c&state=${state}&format=json`,
    });
    const replay = await app.inject({
      method: "GET",
      url: `/oauth/calendly/callback?code=c&state=${state}&format=json`,
    });
    expect(replay.statusCode).toBe(400);
  });

  it("binds the callback to the setup session cookie", async () => {
    const { app } = await setUpApp();
    const start = await app.inject({ method: "GET", url: "/connect/calendly/start?format=json" });
    const { state } = start.json();
    const setCookie = start.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];

    const missingCookie = await app.inject({
      method: "GET",
      url: `/oauth/calendly/callback?code=c&state=${state}&format=json`,
    });
    expect(missingCookie.statusCode).toBe(400);

    const wrongCookie = await app.inject({
      method: "GET",
      url: `/oauth/calendly/callback?code=c&state=${state}&format=json`,
      headers: { cookie: "calendly_setup=wrong" },
    });
    expect(wrongCookie.statusCode).toBe(400);

    const callback = await app.inject({
      method: "GET",
      url: `/oauth/calendly/callback?code=c&state=${state}&format=json`,
      headers: { cookie },
    });
    expect(callback.statusCode).toBe(200);
  });

  it("keeps OAuth state when the token exchange transiently fails", async () => {
    const fake = makeFakeCalendly();
    const config = testConfig();
    let tokenAttempts = 0;
    const oauth = new CalendlyOAuth({
      authBaseUrl: config.calendly.authBaseUrl,
      clientId: config.calendly.clientId!,
      clientSecret: config.calendly.clientSecret,
      mode: "web",
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/oauth/token") && tokenAttempts++ === 0) {
          return new Response(JSON.stringify({ message: "temporary outage" }), { status: 503 });
        }
        return fake.fetchImpl(input, init);
      },
    });
    const app = buildApp({
      config,
      oauth,
      store: createStore({ kind: "memory", path: "" }),
      fetchImpl: fake.fetchImpl,
      logger: false,
    });
    const start = await app.inject({ method: "GET", url: "/connect/calendly/start?format=json" });
    const { state } = start.json();
    const setCookie = start.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
    const callbackUrl = `/oauth/calendly/callback?code=c&state=${state}&format=json`;

    const first = await app.inject({ method: "GET", url: callbackUrl, headers: { cookie } });
    expect(first.statusCode).toBe(502);
    const second = await app.inject({ method: "GET", url: callbackUrl, headers: { cookie } });
    expect(second.statusCode).toBe(200);
  });

  it("returns 503 when Calendly OAuth is not configured", async () => {
    const config = testConfig({ CALENDLY_CLIENT_ID: "", CALENDLY_CLIENT_SECRET: "" });
    const app = buildApp({
      config,
      store: createStore({ kind: "memory", path: "" }),
      fetchImpl: makeFakeCalendly().fetchImpl,
      logger: false,
    });
    const res = await app.inject({ method: "GET", url: "/connect/calendly/start" });
    expect(res.statusCode).toBe(503);
  });

  it("requires the web client secret but permits native mode without one", () => {
    expect(() => testConfig({ CALENDLY_CLIENT_SECRET: "" })).toThrow(/CLIENT_SECRET/);
    expect(testConfig({ CALENDLY_OAUTH_MODE: "native", CALENDLY_CLIENT_SECRET: "" }).calendly.configured).toBe(true);
  });
});

describe("connector API", () => {
  it("requires a bearer connector key", async () => {
    const { app } = await setUpApp();
    const res = await app.inject({ method: "GET", url: "/v1/me" });
    expect(res.statusCode).toBe(401);
  });

  it("returns the connected account", async () => {
    const { app } = await setUpApp();
    const key = await connect(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scheduling.name).toBe("Ada Lovelace");
    expect(body.connection.status).toBe("active");
  });

  it("lists event types", async () => {
    const { app } = await setUpApp();
    const key = await connect(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/event-types",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().eventTypes[0]).toMatchObject({ name: "Intro call", id: "ET1", duration: 30 });
  });

  it("returns availability slots", async () => {
    const { app } = await setUpApp();
    const key = await connect(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/event-types/ET1/availability",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().slots[0]).toMatchObject({
      startTime: "2026-10-01T15:00:00Z",
      status: "available",
    });
  });

  it("books once and replays on Idempotency-Key reuse", async () => {
    const { app, fake } = await setUpApp();
    const key = await connect(app);
    const payload = {
      event_type: "https://api.test/event_types/ET1",
      start_time: "2026-10-01T15:00:00Z",
      invitee: { name: "Ada Lovelace", email: "ada@example.com", timezone: "Europe/London" },
    };
    const headers = {
      authorization: `Bearer ${key}`,
      "idempotency-key": "the-key",
      "content-type": "application/json",
    };

    const first = await app.inject({ method: "POST", url: "/v1/bookings", headers, payload });
    expect(first.statusCode).toBe(201);
    expect(first.json().booking.eventUri).toBe("https://api.test/scheduled_events/E1");
    expect(first.json().idempotentReplay).toBe(false);

    const second = await app.inject({ method: "POST", url: "/v1/bookings", headers, payload });
    expect(second.statusCode).toBe(200);
    expect(second.json().idempotentReplay).toBe(true);
    expect(fake.state.inviteeCreates).toBe(1);
  });

  it("dedupes bookings without a key using the request fingerprint", async () => {
    const { app, fake } = await setUpApp();
    const key = await connect(app);
    const payload = {
      event_type: "https://api.test/event_types/ET1",
      start_time: "2026-10-01T15:00:00Z",
      invitee: { name: "Ada Lovelace", email: "ada@example.com" },
    };
    const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
    await app.inject({ method: "POST", url: "/v1/bookings", headers, payload });
    const second = await app.inject({ method: "POST", url: "/v1/bookings", headers, payload });
    expect(second.json().idempotentReplay).toBe(true);
    expect(fake.state.inviteeCreates).toBe(1);
  });

  it("serves the connector OpenAPI document", async () => {
    const { app } = await setUpApp();
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths["/v1/bookings"].post.operationId).toBe("create_booking");
    expect(spec.servers[0].url).toBe("http://bridge.test");
  });

  it("records an audit trail of agent actions", async () => {
    const { app } = await setUpApp();
    const key = await connect(app);
    const headers = { authorization: `Bearer ${key}` };
    await app.inject({ method: "GET", url: "/v1/me", headers });
    const res = await app.inject({ method: "GET", url: "/v1/audit", headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().events.length).toBeGreaterThanOrEqual(1);
  });
});
