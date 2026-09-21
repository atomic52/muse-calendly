import { createHash, randomUUID } from "node:crypto";
import { randomHex } from "./crypto.js";

export function newId(): string {
  return randomUUID();
}

export interface IssuedConnectorKey {
  /** Full bearer key, shown to the user exactly once. */
  key: string;
  /** Short public id used to index the connection. */
  prefix: string;
  /** sha256 of the secret part; this is all the server stores. */
  hash: string;
}

/**
 * Connector keys look like `cal_<prefix>_<secret>`. Only the prefix and a hash of
 * the secret are persisted, so a store leak does not expose usable keys.
 */
export function issueConnectorKey(): IssuedConnectorKey {
  const prefix = randomHex(6);
  const secret = randomHex(24);
  return {
    key: `cal_${prefix}_${secret}`,
    prefix,
    hash: createHash("sha256").update(secret).digest("hex"),
  };
}

export function parseConnectorKey(key: string): { prefix: string; secret: string } | undefined {
  const match = /^cal_([0-9a-f]{12})_([0-9a-f]{48})$/.exec(key);
  if (!match) return undefined;
  return { prefix: match[1] as string, secret: match[2] as string };
}
