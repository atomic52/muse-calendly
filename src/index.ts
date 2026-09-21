import { loadConfig } from "./config.js";
import { buildApp } from "./http/app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildApp({ config });

  await app.listen({ port: config.port, host: config.host });

  const base = config.publicUrl;
  app.log.info(`Calendly connector bridge listening on ${base}`);
  app.log.info(`Connect Calendly:      ${base}/connect/calendly/start`);
  app.log.info(`Connector OpenAPI:     ${base}/openapi.json`);
  if (!config.calendly.configured) {
    app.log.warn("CALENDLY_CLIENT_ID is not set; the connect flow will return 503.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
