import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../../lib/errors.js";
import { sha256Hex } from "../../lib/crypto.js";
import type { Connection } from "../../store/types.js";
import type { AppContext } from "../app.js";

const IsoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "Expected an ISO-8601 date-time");

const AvailabilityQuery = z.object({ start: IsoDate.optional(), end: IsoDate.optional() });

const BookingBody = z.object({
  event_type: z.string().min(1),
  start_time: IsoDate,
  invitee: z.object({
    name: z.string().min(1),
    email: z.string().email(),
    timezone: z.string().min(1).optional(),
  }),
  event_guests: z.array(z.string().email()).optional(),
  location: z.object({ kind: z.string().min(1), location: z.string().optional() }).optional(),
  questions_and_answers: z
    .array(z.object({ question: z.string(), answer: z.string(), position: z.number().optional() }))
    .optional(),
  tracking: z.record(z.string()).optional(),
});

const CancelBody = z.object({ reason: z.string().max(500).optional() }).default({});

const SchedulingLinkBody = z.object({
  event_type: z.string().min(1),
  max_event_count: z.number().int().positive().max(100).default(1),
});

const ListBookingsQuery = z.object({
  status: z.enum(["active", "canceled"]).optional(),
  min_start_time: IsoDate.optional(),
  max_start_time: IsoDate.optional(),
  count: z.coerce.number().int().min(1).max(100).optional(),
  page_token: z.string().optional(),
});

const AuditQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

export function registerConnectorRoutes(app: FastifyInstance, context: AppContext): void {
  const auth = makeAuthHook(context);

  app.get("/openapi.json", async (_req, reply) => {
    const { loadConnectorSpec } = await import("../../connectorSpec.js");
    return reply.type("application/json").send(loadConnectorSpec(context.config.publicUrl));
  });

  app.get("/v1/me", { preHandler: auth }, async (req) => {
    const connection = conn(req);
    const resource = await context.scheduling.getAccount(connection);
    return {
      connection: context.connections.toPublic(connection),
      scheduling: {
        uri: resource.uri,
        name: resource.name,
        email: resource.email,
        timezone: resource.timezone,
        schedulingUrl: resource.scheduling_url,
        organization: resource.current_organization,
      },
    };
  });

  app.get("/v1/event-types", { preHandler: auth }, async (req) => {
    const connection = conn(req);
    return context.scheduling.listEventTypes(connection);
  });

  app.get("/v1/event-types/:uuid/availability", { preHandler: auth }, async (req) => {
    const connection = conn(req);
    const { uuid } = req.params as { uuid: string };
    const query = AvailabilityQuery.parse(req.query);
    return context.scheduling.getAvailability(connection, {
      eventTypeUuid: uuid,
      start: query.start,
      end: query.end,
    });
  });

  app.post("/v1/bookings", { preHandler: auth }, async (req, reply) => {
    const connection = conn(req);
    const body = BookingBody.parse(req.body);
    const idempotencyKey = readIdempotencyKey(req) ?? `auto:${sha256Hex(stableStringify(body))}`;
    const requestHash = sha256Hex(stableStringify(body));

    const result = await context.idempotency.run(
      connection.id,
      idempotencyKey,
      requestHash,
      async () => {
        const booking = await context.scheduling.createBooking(connection, body);
        return { status: 201, body: { booking } };
      },
    );

    reply.status(result.replayed ? 200 : 201);
    return { ...result.body, idempotentReplay: result.replayed };
  });

  app.get("/v1/bookings", { preHandler: auth }, async (req) => {
    const connection = conn(req);
    const query = ListBookingsQuery.parse(req.query);
    return context.scheduling.listBookings(connection, {
      status: query.status,
      minStartTime: query.min_start_time,
      maxStartTime: query.max_start_time,
      count: query.count,
      pageToken: query.page_token,
    });
  });

  app.post("/v1/bookings/:uuid/cancel", { preHandler: auth }, async (req) => {
    const connection = conn(req);
    const { uuid } = req.params as { uuid: string };
    const body = CancelBody.parse(req.body ?? {});
    return context.scheduling.cancelBooking(connection, uuid, body.reason);
  });

  app.post("/v1/scheduling-links", { preHandler: auth }, async (req) => {
    const connection = conn(req);
    const body = SchedulingLinkBody.parse(req.body);
    return context.scheduling.createSchedulingLink(connection, {
      eventType: body.event_type,
      maxEventCount: body.max_event_count,
    });
  });

  app.get("/v1/audit", { preHandler: auth }, async (req) => {
    const connection = conn(req);
    const { limit } = AuditQuery.parse(req.query);
    const events = await context.store.listAudit(connection.id, limit);
    return { events };
  });
}

function makeAuthHook(context: AppContext) {
  return async (req: FastifyRequest): Promise<void> => {
    const header = req.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");
    if (!scheme || scheme.toLowerCase() !== "bearer" || !token) {
      throw new ApiError("unauthorized", "Missing bearer connector key.");
    }
    const connection = await context.connections.authenticate(token);
    const decision = context.rateLimiter.check(connection.id);
    if (!decision.allowed) {
      throw new ApiError("rate_limited", "Connector rate limit reached. Retry shortly.", {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }
    req.connection = connection;
  };
}

function conn(req: FastifyRequest): Connection {
  if (!req.connection) throw new ApiError("unauthorized", "Not authenticated.");
  return req.connection;
}

function readIdempotencyKey(req: FastifyRequest): string | undefined {
  const raw = req.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  if (value.length > 200) throw new ApiError("validation_error", "Idempotency-Key is too long.");
  return `key:${value}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
