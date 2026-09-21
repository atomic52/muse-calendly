import type { Connection } from "../store/types.js";

declare module "fastify" {
  interface FastifyRequest {
    connection?: Connection;
  }
}

export {};
