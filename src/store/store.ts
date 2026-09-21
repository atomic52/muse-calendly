import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AuditEvent,
  Connection,
  IdempotencyRecord,
  PendingAuth,
  Store,
} from "./types.js";

export interface StoreOptions {
  kind: "memory" | "file";
  path: string;
  pendingTtlMs?: number;
  idempotencyTtlMs?: number;
  maxAuditEvents?: number;
}

interface Snapshot {
  connections: Connection[];
  pending: PendingAuth[];
  idempotency: IdempotencyRecord[];
  audit: AuditEvent[];
}

const EMPTY: Snapshot = { connections: [], pending: [], idempotency: [], audit: [] };

export function createStore(options: StoreOptions): Store {
  return new BridgeStore(options);
}

class BridgeStore implements Store {
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Map<string, PendingAuth>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private audit: AuditEvent[] = [];
  private saveTimer: NodeJS.Timeout | undefined;

  private readonly pendingTtlMs: number;
  private readonly idempotencyTtlMs: number;
  private readonly maxAuditEvents: number;

  constructor(private readonly options: StoreOptions) {
    this.pendingTtlMs = options.pendingTtlMs ?? 10 * 60 * 1000;
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? 24 * 60 * 60 * 1000;
    this.maxAuditEvents = options.maxAuditEvents ?? 5000;
    if (options.kind === "file") this.load();
  }

  private load(): void {
    if (!existsSync(this.options.path)) return;
    try {
      const snapshot = JSON.parse(readFileSync(this.options.path, "utf8")) as Snapshot;
      for (const c of snapshot.connections ?? []) this.connections.set(c.id, c);
      for (const p of snapshot.pending ?? []) this.pending.set(p.state, p);
      for (const r of snapshot.idempotency ?? []) this.idempotency.set(recKey(r.connectionId, r.key), r);
      this.audit = snapshot.audit ?? [];
    } catch (err) {
      console.error(`[store] failed to load ${this.options.path}:`, err);
    }
  }

  private persist(): void {
    if (this.options.kind !== "file") return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      const snapshot: Snapshot = {
        connections: [...this.connections.values()],
        pending: [...this.pending.values()],
        idempotency: [...this.idempotency.values()],
        audit: this.audit,
      };
      const tmp = `${this.options.path}.tmp`;
      try {
        mkdirSync(dirname(this.options.path), { recursive: true });
        writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
        renameSync(tmp, this.options.path);
      } catch (err) {
        console.error(`[store] failed to persist ${this.options.path}:`, err);
      }
    }, 50);
  }

  async createConnection(connection: Connection): Promise<void> {
    this.connections.set(connection.id, { ...connection });
    this.persist();
  }

  async getConnection(id: string): Promise<Connection | undefined> {
    const found = this.connections.get(id);
    return found ? { ...found } : undefined;
  }

  async getConnectionByKeyPrefix(prefix: string): Promise<Connection | undefined> {
    for (const connection of this.connections.values()) {
      if (connection.connectorKeyPrefix === prefix) return { ...connection };
    }
    return undefined;
  }

  async updateConnection(id: string, patch: Partial<Connection>): Promise<Connection> {
    const existing = this.connections.get(id);
    if (!existing) throw new Error(`Connection not found: ${id}`);
    const updated: Connection = { ...existing, ...patch, updatedAt: Date.now() };
    this.connections.set(id, updated);
    this.persist();
    return { ...updated };
  }

  async listConnections(): Promise<Connection[]> {
    return [...this.connections.values()].map((c) => ({ ...c }));
  }

  async putPending(pending: PendingAuth): Promise<void> {
    this.pending.set(pending.state, pending);
    this.persist();
  }

  async getPending(state: string): Promise<PendingAuth | undefined> {
    const found = this.pending.get(state);
    if (!found) return undefined;
    if (Date.now() - found.createdAt > this.pendingTtlMs) {
      this.pending.delete(state);
      this.persist();
      return undefined;
    }
    return { ...found };
  }

  async deletePending(state: string): Promise<void> {
    this.pending.delete(state);
    this.persist();
  }

  async consumePending(state: string): Promise<PendingAuth | undefined> {
    const found = await this.getPending(state);
    if (found) await this.deletePending(state);
    return found;
  }

  async getIdempotency(connectionId: string, key: string): Promise<IdempotencyRecord | undefined> {
    const found = this.idempotency.get(recKey(connectionId, key));
    if (!found) return undefined;
    if (Date.now() - found.createdAt > this.idempotencyTtlMs) {
      this.idempotency.delete(recKey(connectionId, key));
      return undefined;
    }
    return found;
  }

  async putIdempotency(record: IdempotencyRecord): Promise<void> {
    this.idempotency.set(recKey(record.connectionId, record.key), record);
    this.persist();
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    this.audit.push(event);
    if (this.audit.length > this.maxAuditEvents) {
      this.audit = this.audit.slice(-this.maxAuditEvents);
    }
    this.persist();
  }

  async listAudit(connectionId: string, limit: number): Promise<AuditEvent[]> {
    return this.audit
      .filter((e) => e.connectionId === connectionId)
      .slice(-limit)
      .reverse();
  }
}

function recKey(connectionId: string, key: string): string {
  return `${connectionId}::${key}`;
}
