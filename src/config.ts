import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default("0.0.0.0"),
  BRIDGE_PUBLIC_URL: z.string().url().default("http://localhost:8787"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  DEV_KEY_PATH: z.string().default(".data/enc.key"),

  CALENDLY_CLIENT_ID: z.string().optional(),
  CALENDLY_CLIENT_SECRET: z.string().optional(),
  CALENDLY_OAUTH_MODE: z.enum(["web", "native"]).default("web"),
  CALENDLY_REDIRECT_URI: z.string().url().optional(),
  CALENDLY_AUTH_BASE_URL: z.string().url().default("https://auth.calendly.com"),
  CALENDLY_API_BASE_URL: z.string().url().default("https://api.calendly.com"),
  CALENDLY_SCOPES: z
    .string()
    .default(
      "users:read event_types:read availability:read scheduled_events:read scheduled_events:write scheduling_links:write",
    ),

  STORE_KIND: z.enum(["memory", "file"]).default("file"),
  STORE_PATH: z.string().default(".data/bridge.json"),

  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().positive().default(24),
});

export interface AppConfig {
  port: number;
  host: string;
  publicUrl: string;
  logLevel: string;
  encryptionKey: Buffer;
  calendly: {
    clientId?: string;
    clientSecret?: string;
    mode: "web" | "native";
    redirectUri: string;
    authBaseUrl: string;
    apiBaseUrl: string;
    scopes: string[];
    configured: boolean;
  };
  store: { kind: "memory" | "file"; path: string };
  rateLimitPerMinute: number;
  idempotencyTtlMs: number;
}

function loadEncryptionKey(env: z.infer<typeof EnvSchema>): Buffer {
  if (env.TOKEN_ENCRYPTION_KEY) {
    const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "hex");
    if (key.length !== 32) {
      throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes of hex (64 hex chars).");
    }
    return key;
  }
  const devPath = resolve(process.cwd(), env.DEV_KEY_PATH);
  if (existsSync(devPath)) return Buffer.from(readFileSync(devPath, "utf8").trim(), "hex");
  const generated = randomBytes(32);
  mkdirSync(dirname(devPath), { recursive: true });
  writeFileSync(devPath, generated.toString("hex"), { mode: 0o600 });
  try {
    chmodSync(devPath, 0o600);
  } catch {
    /* best effort */
  }
  console.warn(
    `[config] TOKEN_ENCRYPTION_KEY not set; generated a dev key at ${devPath}. ` +
      "Set TOKEN_ENCRYPTION_KEY in production.",
  );
  return generated;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = EnvSchema.parse(source);
  if (env.CALENDLY_CLIENT_SECRET && !env.CALENDLY_CLIENT_ID) {
    throw new Error("CALENDLY_CLIENT_ID is required when CALENDLY_CLIENT_SECRET is set.");
  }
  if (env.CALENDLY_OAUTH_MODE === "web" && env.CALENDLY_CLIENT_ID && !env.CALENDLY_CLIENT_SECRET) {
    throw new Error("CALENDLY_CLIENT_SECRET is required for web OAuth mode.");
  }
  const publicUrl = env.BRIDGE_PUBLIC_URL.replace(/\/$/, "");
  const redirectUri = env.CALENDLY_REDIRECT_URI ?? `${publicUrl}/oauth/calendly/callback`;
  const configured = Boolean(env.CALENDLY_CLIENT_ID && (env.CALENDLY_OAUTH_MODE === "native" || env.CALENDLY_CLIENT_SECRET));
  return {
    port: env.PORT,
    host: env.HOST,
    publicUrl,
    logLevel: env.LOG_LEVEL,
    encryptionKey: loadEncryptionKey(env),
    calendly: {
      clientId: env.CALENDLY_CLIENT_ID,
      clientSecret: env.CALENDLY_CLIENT_SECRET,
      mode: env.CALENDLY_OAUTH_MODE,
      redirectUri,
      authBaseUrl: env.CALENDLY_AUTH_BASE_URL.replace(/\/$/, ""),
      apiBaseUrl: env.CALENDLY_API_BASE_URL.replace(/\/$/, ""),
      scopes: env.CALENDLY_SCOPES.split(/\s+/).filter(Boolean),
      configured,
    },
    store: { kind: env.STORE_KIND, path: env.STORE_PATH },
    rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
    idempotencyTtlMs: env.IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000,
  };
}
