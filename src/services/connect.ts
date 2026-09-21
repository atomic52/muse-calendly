import { generatePkce, randomHex } from "../lib/crypto.js";
import { ApiError } from "../lib/errors.js";
import type { CalendlyApiClient } from "../calendly/client.js";
import type { CalendlyOAuth } from "../calendly/oauth.js";
import type { CalendlyUserResource } from "../calendly/types.js";
import type { Store } from "../store/types.js";
import type { ConnectionService, CreatedConnection } from "./connections.js";

export interface StartConnectResult {
  url: string;
  state: string;
}

const stateLocks = new Map<string, Promise<unknown>>();

export class ConnectService {
  constructor(
    private readonly oauth: CalendlyOAuth,
    private readonly client: CalendlyApiClient,
    private readonly connections: ConnectionService,
    private readonly store: Store,
    private readonly redirectUri: string,
  ) {}

  async start(setupId: string): Promise<StartConnectResult> {
    const { verifier, challenge } = generatePkce();
    const state = randomHex(16);
    await this.store.putPending({
      state,
      codeVerifier: verifier,
      redirectUri: this.redirectUri,
      setupId,
      createdAt: Date.now(),
    });
    const url = this.oauth.buildAuthorizeUrl({
      redirectUri: this.redirectUri,
      state,
      codeChallenge: challenge,
    });
    return { url, state };
  }

  async complete(code: string, state: string, setupId: string): Promise<CreatedConnection> {
    return this.withStateLock(state, async () => {
      const pending = await this.store.getPending(state);
      if (!pending || pending.setupId !== setupId) {
        throw new ApiError(
          "validation_error",
          "This Calendly connect link is invalid, expired, or belongs to another setup session.",
        );
      }
      const tokens = await this.oauth.exchangeCode({
        code,
        redirectUri: pending.redirectUri,
        codeVerifier: pending.codeVerifier,
      });
      await this.store.deletePending(state);
      const user = await this.fetchUser(tokens.access_token);
      return this.connections.create({ tokens, user });
    });
  }

  private async withStateLock<T>(state: string, fn: () => Promise<T>): Promise<T> {
    const previous = stateLocks.get(state) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const guard = run.catch(() => undefined);
    stateLocks.set(state, guard);
    try {
      return await run;
    } finally {
      if (stateLocks.get(state) === guard) stateLocks.delete(state);
    }
  }

  private async fetchUser(accessToken: string): Promise<CalendlyUserResource> {
    const res = await this.client.request<{ resource: CalendlyUserResource }>(
      accessToken,
      "GET",
      "/users/me",
    );
    if (!res.ok) {
      throw new ApiError(
        "calendly_error",
        `Connected to Calendly but could not read your profile (HTTP ${res.status}).`,
      );
    }
    return res.data.resource;
  }
}
