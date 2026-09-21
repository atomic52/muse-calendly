import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";

export function registerHealthRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/healthz", async () => ({
    status: "ok",
    calendlyConfigured: context.config.calendly.configured,
    connectUrl: `${context.config.publicUrl}/connect/calendly/start`,
  }));
}
