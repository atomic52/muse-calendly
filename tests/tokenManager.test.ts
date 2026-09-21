import { describe, expect, it } from "vitest";
import { CalendlyOAuth } from "../src/calendly/oauth.js";
import { TokenManager } from "../src/calendly/tokenManager.js";
import { decrypt } from "../src/lib/crypto.js";
import { ApiError } from "../src/lib/errors.js";
import { ConnectionService } from "../src/services/connections.js";
import { createStore } from "../src/store/store.js";
import { makeFakeCalendly, testConfig } from "./helpers.js";

async function setup() {
  const fake = makeFakeCalendly();
  const config = testConfig();
  const store = createStore({ kind: "memory", path: "" });
  const oauth = new CalendlyOAuth({
    authBaseUrl: config.calendly.authBaseUrl,
    clientId: config.calendly.clientId!,
    clientSecret: config.calendly.clientSecret,
    mode: "web",
    fetchImpl: fake.fetchImpl,
  });
  const connections = new ConnectionService(store, config.encryptionKey);
  const { connection } = await connections.create({
    tokens: {
      token_type: "Bearer",
      access_token: "access-initial",
      refresh_token: "refresh-initial",
      created_at: 0,
      expires_in: 3600,
      owner: "https://api.test/users/U1",
      organization: "https://api.test/organizations/O1",
    },
    user: {
      uri: "https://api.test/users/U1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      timezone: "Europe/London",
      current_organization: "https://api.test/organizations/O1",
    },
  });
  const tokenManager = new TokenManager(store, oauth, config.encryptionKey);
  return { fake, config, store, tokenManager, connection };
}

function expire(store: ReturnType<typeof createStore>, id: string) {
  return store.updateConnection(id, { accessExpiresAt: Date.now() - 1000 });
}

describe("TokenManager", () => {
  it("returns the cached token while it is still valid", async () => {
    const { fake, tokenManager, connection } = await setup();
    const result = await tokenManager.getAccessToken(connection.id);
    expect(result.accessToken).toBe("access-initial");
    expect(fake.state.tokenRequests).toBe(0);
  });

  it("refreshes and rotates the stored refresh token when expired", async () => {
    const { fake, store, tokenManager, connection, config } = await setup();
    await expire(store, connection.id);

    const result = await tokenManager.getAccessToken(connection.id);
    expect(fake.state.tokenRequests).toBe(1);
    expect(result.accessToken).toBe("access-1");

    const stored = await store.getConnection(connection.id);
    expect(decrypt(stored!.refreshTokenEnc, config.encryptionKey)).toBe("refresh-1");
    expect(decrypt(stored!.accessTokenEnc, config.encryptionKey)).toBe("access-1");
  });

  it("serializes concurrent refreshes into a single rotation", async () => {
    const { fake, store, tokenManager, connection } = await setup();
    await expire(store, connection.id);

    const [a, b] = await Promise.all([
      tokenManager.getAccessToken(connection.id),
      tokenManager.getAccessToken(connection.id),
    ]);
    expect(fake.state.tokenRequests).toBe(1);
    expect(a.accessToken).toBe(b.accessToken);
  });

  it("reuses an already-refreshed token instead of rotating again on 401", async () => {
    const { fake, tokenManager, connection } = await setup();
    const first = await tokenManager.getAccessToken(connection.id); // access-initial
    // Another request already rotated the token to access-1.
    await tokenManager.forceRefresh(connection.id);
    const retry = await tokenManager.forceRefresh(connection.id, first.accessToken);
    expect(retry.accessToken).toBe("access-1");
    expect(fake.state.tokenRequests).toBe(1);
  });

  it("marks the connection for reconnect on invalid_grant", async () => {
    const { fake, store, tokenManager, connection } = await setup();
    fake.state.invalidGrant = true;
    await expire(store, connection.id);

    await expect(tokenManager.getAccessToken(connection.id)).rejects.toMatchObject({
      code: "needs_reconnect",
    });
    const stored = await store.getConnection(connection.id);
    expect(stored!.status).toBe("needs_reconnect");
    await expect(tokenManager.getAccessToken(connection.id)).rejects.toBeInstanceOf(ApiError);
  });
});
