import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { ApiError } from "../lib/errors.js";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      reply.status(err.status).send(err.toJSON());
      return;
    }
    if (err instanceof ZodError) {
      reply.status(400).send({
        error: { code: "validation_error", message: "Invalid request.", details: err.issues },
      });
      return;
    }
    if (typeof (err as { statusCode?: number }).statusCode === "number") {
      const statusCode = (err as { statusCode: number }).statusCode;
      if (statusCode < 500) {
        reply.status(statusCode).send({
          error: { code: "validation_error", message: (err as Error).message },
        });
        return;
      }
    }
    req.log.error(err);
    reply.status(500).send({ error: { code: "internal", message: "Unexpected server error." } });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: { code: "not_found", message: `No route for ${req.method} ${req.url}.` } });
  });
}
