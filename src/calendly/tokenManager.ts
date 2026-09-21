import { decrypt, encrypt } from "../lib/crypto.js";
import { ApiError, isApiError } from "../lib/errors.js";
import type { Connection, Store } from "../store/types.js";
import type { CalendlyOAuth } from "./oauth.js";

const EXPIRY_SKEW_MS = 60_000;

export interface AccessToken {
  connection: Connection;
  accessToken: string;
}

/**
 * Owns Calendly token lifecycle. Refresh tokens are single-use and rotate, so
 * refreshes are serialized per connection: a second concurrent caller reuses the
 * token produced by the first instead of burning a second rotation.
 */
export class TokenManager {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: Store,
    private readonly oauth: CalendlyOAuth,
    private readonly encryptionKey: Buffer,
  ) {}

  async getAccessToken(connectionId: string): Promise<AccessToken> {
    const connection = await this.requireConnection(connectionId);
    assertActive(connection);
    if (connection.accessExpiresAt > Date.now() + EXPIRY_SKEW_MS) {
      return { connection, accessToken: this.decryptAccess(connection) };
    }
    return this.refreshLocked(connectionId, { staleAccessToken: undefined });
  }

  /**
   * Called after Calendly returns 401. If another request already refreshed (the
   * stored token differs from the one that failed), reuse it instead of rotating
   * again.
   */
  async forceRefresh(connectionId: string, staleAccessToken?: string): Promise<AccessToken> {
    return this.refreshLocked(connectionId, { staleAccessToken });
  }

  private async refreshLocked(
    connectionId: string,
    opts: { staleAccessToken?: string },
  ): Promise<AccessToken> {
    return this.withLock(connectionId, async () => {
      const connection = await this.requireConnection(connectionId);
      assertActive(connection);

      if (opts.staleAccessToken !== undefined) {
        const current = this.decryptAccess(connection);
        if (current !== opts.staleAccessToken) {
          return { connection, accessToken: current };
        }
      } else if (connection.accessExpiresAt > Date.now() + EXPIRY_SKEW_MS) {
        return { connection, accessToken: this.decryptAccess(connection) };
      }

      const refreshToken = decrypt(connection.refreshTokenEnc, this.encryptionKey);
      let tokens;
      try {
        tokens = await this.oauth.refresh(refreshToken);
      } catch (err) {
        if (isApiError(err) && err.code === "needs_reconnect") {
          await this.store.updateConnection(connectionId, { status: "needs_reconnect" });
        }
        throw err;
      }

      const updated = await this.store.updateConnection(connectionId, {
        accessTokenEnc: encrypt(tokens.access_token, this.encryptionKey),
        refreshTokenEnc: encrypt(tokens.refresh_token, this.encryptionKey),
        accessExpiresAt: Date.now() + tokens.expires_in * 1000,
        scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : connection.scopes,
        status: "active",
      });
      return { connection: updated, accessToken: tokens.access_token };
    });
  }

  private async requireConnection(connectionId: string): Promise<Connection> {
    const connection = await this.store.getConnection(connectionId);
    if (!connection) throw new ApiError("not_found", "Calendly connection not found.");
    return connection;
  }

  private decryptAccess(connection: Connection): string {
    return decrypt(connection.accessTokenEnc, this.encryptionKey);
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const guard = run.catch(() => undefined);
    this.locks.set(id, guard);
    try {
      return await run;
    } finally {
      if (this.locks.get(id) === guard) this.locks.delete(id);
    }
  }
}

function assertActive(connection: Connection): void {
  if (connection.status === "needs_reconnect") {
    throw new ApiError(
      "needs_reconnect",
      "Calendly access must be reconnected. Ask the user to reconnect Calendly.",
    );
  }
}
