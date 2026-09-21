import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decrypt, encrypt, generatePkce, safeEqualHex, sha256Hex } from "../src/lib/crypto.js";
import { issueConnectorKey, parseConnectorKey } from "../src/lib/ids.js";

describe("crypto", () => {
  const key = randomBytes(32);

  it("round-trips a value", () => {
    const blob = encrypt("refresh-token-value", key);
    expect(blob.startsWith("v1.")).toBe(true);
    expect(decrypt(blob, key)).toBe("refresh-token-value");
  });

  it("rejects tampered ciphertext", () => {
    const blob = encrypt("secret", key);
    const parts = blob.split(".");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decrypt(parts.join("."), key)).toThrow();
  });

  it("fails with the wrong key", () => {
    const blob = encrypt("secret", key);
    expect(() => decrypt(blob, randomBytes(32))).toThrow();
  });

  it("produces an S256 PKCE challenge", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    expect(challenge).not.toBe(verifier);
  });

  it("issues parseable connector keys with matching hashes", () => {
    const issued = issueConnectorKey();
    const parsed = parseConnectorKey(issued.key);
    expect(parsed).toBeDefined();
    expect(sha256Hex(parsed!.secret)).toBe(issued.hash);
    expect(parsed!.prefix).toBe(issued.prefix);
  });

  it("rejects malformed connector keys", () => {
    expect(parseConnectorKey("cal_bad")).toBeUndefined();
    expect(parseConnectorKey("nope")).toBeUndefined();
  });

  it("compares hashes safely", () => {
    expect(safeEqualHex("aa", "aa")).toBe(true);
    expect(safeEqualHex("aa", "ab")).toBe(false);
    expect(safeEqualHex("aa", "aab")).toBe(false);
  });
});
