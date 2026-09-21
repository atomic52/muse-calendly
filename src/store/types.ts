export type ConnectionStatus = "active" | "needs_reconnect";

export interface Connection {
  id: string;
  connectorKeyPrefix: string;
  connectorKeyHash: string;
  status: ConnectionStatus;
  scopes: string[];
  /** AES-256-GCM blobs; never store plaintext tokens. */
  accessTokenEnc: string;
  refreshTokenEnc: string;
  accessExpiresAt: number;
  userUri?: string;
  organizationUri?: string;
  ownerName?: string;
  ownerEmail?: string;
  timezone?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PendingAuth {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  setupId: string;
  createdAt: number;
}

export interface IdempotencyRecord {
  connectionId: string;
  key: string;
  requestHash: string;
  status: number;
  response: unknown;
  createdAt: number;
}

export type AuditActor = "agent" | "user" | "system";

export interface AuditEvent {
  id: string;
  connectionId: string | null;
  actor: AuditActor;
  action: string;
  method: string;
  path: string;
  outcome: "success" | "error";
  status: number;
  latencyMs: number;
  detail?: string;
  at: number;
}

export interface Store {
  createConnection(connection: Connection): Promise<void>;
  getConnection(id: string): Promise<Connection | undefined>;
  getConnectionByKeyPrefix(prefix: string): Promise<Connection | undefined>;
  updateConnection(id: string, patch: Partial<Connection>): Promise<Connection>;
  listConnections(): Promise<Connection[]>;

  putPending(pending: PendingAuth): Promise<void>;
  getPending(state: string): Promise<PendingAuth | undefined>;
  deletePending(state: string): Promise<void>;
  consumePending(state: string): Promise<PendingAuth | undefined>;

  getIdempotency(connectionId: string, key: string): Promise<IdempotencyRecord | undefined>;
  putIdempotency(record: IdempotencyRecord): Promise<void>;

  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(connectionId: string, limit: number): Promise<AuditEvent[]>;
}
