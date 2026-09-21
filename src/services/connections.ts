import { encrypt, safeEqualHex, sha256Hex } from "../lib/crypto.js";
import { ApiError } from "../lib/errors.js";
import { issueConnectorKey, newId, parseConnectorKey } from "../lib/ids.js";
import type { Connection, Store } from "../store/types.js";
import type { CalendlyTokenResponse, CalendlyUserResource } from "../calendly/types.js";

export interface CreateConnectionInput {
  tokens: CalendlyTokenResponse;
  user: CalendlyUserResource;
}

export interface CreatedConnection {
  connection: Connection;
  /** Shown to the user exactly once. */
  connectorKey: string;
}

export interface PublicConnection {
  id: string;
  status: Connection["status"];
  ownerName?: string;
  ownerEmail?: string;
  timezone?: string;
  organizationUri?: string;
  userUri?: string;
  scopes: string[];
  connectedAt: string;
}

export class ConnectionService {
  constructor(
    private readonly store: Store,
    private readonly encryptionKey: Buffer,
  ) {}

  async create(input: CreateConnectionInput): Promise<CreatedConnection> {
    const issued = issueConnectorKey();
    const now = Date.now();
    const connection: Connection = {
      id: newId(),
      connectorKeyPrefix: issued.prefix,
      connectorKeyHash: issued.hash,
      status: "active",
      scopes: input.tokens.scope ? input.tokens.scope.split(/\s+/).filter(Boolean) : [],
      accessTokenEnc: encrypt(input.tokens.access_token, this.encryptionKey),
      refreshTokenEnc: encrypt(input.tokens.refresh_token, this.encryptionKey),
      accessExpiresAt: now + input.tokens.expires_in * 1000,
      userUri: input.user.uri,
      organizationUri: input.user.current_organization,
      ownerName: input.user.name,
      ownerEmail: input.user.email,
      timezone: input.user.timezone,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createConnection(connection);
    return { connection, connectorKey: issued.key };
  }

  async authenticate(bearer: string): Promise<Connection> {
    const parsed = parseConnectorKey(bearer);
    if (!parsed) throw new ApiError("unauthorized", "Invalid connector key.");
    const connection = await this.store.getConnectionByKeyPrefix(parsed.prefix);
    if (!connection || !safeEqualHex(connection.connectorKeyHash, sha256Hex(parsed.secret))) {
      throw new ApiError("unauthorized", "Invalid connector key.");
    }
    return connection;
  }

  toPublic(connection: Connection): PublicConnection {
    return {
      id: connection.id,
      status: connection.status,
      ownerName: connection.ownerName,
      ownerEmail: connection.ownerEmail,
      timezone: connection.timezone,
      organizationUri: connection.organizationUri,
      userUri: connection.userUri,
      scopes: connection.scopes,
      connectedAt: new Date(connection.createdAt).toISOString(),
    };
  }
}
