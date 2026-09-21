import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { CalendlyApiClient } from "../calendly/client.js";
import { CalendlyOAuth } from "../calendly/oauth.js";
import { TokenManager } from "../calendly/tokenManager.js";
import type { FetchLike } from "../calendly/types.js";
import { createStore } from "../store/store.js";
import type { Store } from "../store/types.js";
import { ConnectionService } from "../services/connections.js";
import { ConnectService } from "../services/connect.js";
import { IdempotencyService } from "../services/idempotency.js";
import { RateLimiter } from "../services/ratelimit.js";
import { SchedulingService } from "../services/scheduling.js";
import { recordAudit } from "../services/audit.js";
import { registerErrorHandler } from "./errors.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerConnectRoutes } from "./routes/connect.js";
import { registerConnectorRoutes } from "./routes/connector.js";

export interface AppContext {
  config: AppConfig;
  store: Store;
  client: CalendlyApiClient;
  oauth: CalendlyOAuth;
  connections: ConnectionService;
  connect: ConnectService;
  tokenManager: TokenManager;
  idempotency: IdempotencyService;
  rateLimiter: RateLimiter;
  scheduling: SchedulingService;
}

export interface BuildAppOptions {
  config: AppConfig;
  store?: Store;
  oauth?: CalendlyOAuth;
  client?: CalendlyApiClient;
  fetchImpl?: FetchLike;
  logger?: boolean | Record<string, unknown>;
  now?: () => number;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { config } = options;
  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
    bodyLimit: 256 * 1024,
  });

  const store =
    options.store ??
    createStore({
      kind: config.store.kind,
      path: config.store.path,
      idempotencyTtlMs: config.idempotencyTtlMs,
    });

  const client =
    options.client ?? new CalendlyApiClient({ apiBaseUrl: config.calendly.apiBaseUrl, fetchImpl: options.fetchImpl });

  const oauth =
    options.oauth ??
    new CalendlyOAuth({
      authBaseUrl: config.calendly.authBaseUrl,
      clientId: config.calendly.clientId ?? "unconfigured",
      clientSecret: config.calendly.clientSecret,
      mode: config.calendly.mode,
      fetchImpl: options.fetchImpl,
    });

  const connections = new ConnectionService(store, config.encryptionKey);
  const tokenManager = new TokenManager(store, oauth, config.encryptionKey);
  const context: AppContext = {
    config,
    store,
    client,
    oauth,
    connections,
    tokenManager,
    idempotency: new IdempotencyService(store),
    rateLimiter: new RateLimiter(config.rateLimitPerMinute, 60_000, options.now),
    scheduling: new SchedulingService(tokenManager, client, config.calendly.apiBaseUrl),
    connect: new ConnectService(oauth, client, connections, store, config.calendly.redirectUri),
  };

  registerErrorHandler(app);
  app.addHook("onResponse", async (req, reply) => {
    if (!req.url.startsWith("/v1/")) return;
    const routeUrl = req.routeOptions?.url ?? req.url;
    try {
      await recordAudit(store, {
        connectionId: req.connection?.id ?? null,
        actor: "agent",
        action: `${req.method} ${routeUrl}`,
        method: req.method,
        path: req.url.split("?")[0] ?? req.url,
        outcome: reply.statusCode < 400 ? "success" : "error",
        status: reply.statusCode,
        latencyMs: Math.round(reply.elapsedTime),
      });
    } catch (err) {
      req.log.warn({ err }, "audit write failed");
    }
  });

  registerHealthRoutes(app, context);
  registerConnectRoutes(app, context);
  registerConnectorRoutes(app, context);

  return app;
}
