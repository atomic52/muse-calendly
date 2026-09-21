import { newId } from "../lib/ids.js";
import type { AuditActor, AuditEvent, Store } from "../store/types.js";

export interface AuditInput {
  connectionId: string | null;
  actor: AuditActor;
  action: string;
  method: string;
  path: string;
  outcome: "success" | "error";
  status: number;
  latencyMs: number;
  detail?: string;
}

export async function recordAudit(store: Store, input: AuditInput): Promise<void> {
  const event: AuditEvent = { id: newId(), at: Date.now(), ...input };
  await store.appendAudit(event);
}
