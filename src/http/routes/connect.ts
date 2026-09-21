import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { ApiError } from "../../lib/errors.js";
import { randomHex } from "../../lib/crypto.js";
import type { AppContext } from "../app.js";

const StartQuery = z.object({ format: z.enum(["json", "redirect"]).optional() });
const CallbackQuery = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
  format: z.enum(["json", "html"]).optional(),
});
const SETUP_COOKIE = "calendly_setup";
const SETUP_COOKIE_MAX_AGE = 10 * 60;

export function registerConnectRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/connect/calendly/start", async (req, reply) => {
    if (!context.config.calendly.configured) {
      throw new ApiError(
        "not_configured",
        "Calendly OAuth is not configured. Set CALENDLY_CLIENT_ID and the mode-specific credentials.",
      );
    }
    const { format } = StartQuery.parse(req.query);
    const setupId = readCookie(req.headers.cookie, SETUP_COOKIE) ?? randomHex(24);
    const { url, state } = await context.connect.start(setupId);
    if (!readCookie(req.headers.cookie, SETUP_COOKIE)) {
      reply.header("set-cookie", setupCookie(setupId, context.config.publicUrl));
    }
    if (format === "json") return { authorizeUrl: url, state };
    return reply.redirect(url);
  });

  app.get("/oauth/calendly/callback", async (req, reply) => {
    const query = CallbackQuery.parse(req.query);
    if (query.error) {
      throw new ApiError(
        "validation_error",
        query.error_description ?? `Calendly authorization failed: ${query.error}`,
      );
    }
    if (!query.code || !query.state) {
      throw new ApiError("validation_error", "Missing code or state in the Calendly callback.");
    }
    const setupId = readCookie(req.headers.cookie, SETUP_COOKIE);
    if (!setupId) {
      throw new ApiError("validation_error", "Missing Calendly setup session. Start the connection again.");
    }

    const { connectorKey, connection } = await context.connect.complete(query.code, query.state, setupId);
    const publicConnection = context.connections.toPublic(connection);
    reply.header("cache-control", "no-store");
    reply.header("set-cookie", clearSetupCookie(context.config.publicUrl));

    if (query.format === "json") return { connectorKey, connection: publicConnection };
    return reply
      .status(200)
      .type("text/html; charset=utf-8")
      .send(renderSuccessPage(connectorKey, publicConnection.ownerName, context.config.publicUrl));
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderSuccessPage(key: string, owner: string | undefined, publicUrl: string): string {
  const who = owner ? escapeHtml(owner) : "your Calendly account";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Calendly connected</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 20px; line-height: 1.55; color: #111; }
    code { background: #f2f2f2; padding: 3px 7px; border-radius: 5px; font-size: 1.05em; word-break: break-all; }
    .key { display: block; background: #111; color: #fff; padding: 14px 16px; border-radius: 8px; font-family: ui-monospace, monospace; margin: 14px 0; }
    .warn { background: #fff4e5; border: 1px solid #ffb84d; padding: 12px 14px; border-radius: 8px; }
    ol { padding-left: 20px; }
  </style>
</head>
<body>
  <h1>Calendly connected</h1>
  <p>${who} is now linked to the connector bridge.</p>
  <div class="warn">
    <strong>Copy this connector key now.</strong> It is shown only once. Paste it into
    Muse's secure credential prompt &mdash; never into the chat.
  </div>
  <code class="key">${escapeHtml(key)}</code>
  <h2>Add it to Muse</h2>
  <ol>
    <li>Ask Muse to build a custom connector for Calendly.</li>
    <li>Point it at the connector OpenAPI spec: <code>${escapeHtml(publicUrl)}/openapi.json</code></li>
    <li>When prompted for credentials, paste the connector key above as the bearer token.</li>
    <li>Keep Muse approvals on for booking and cancellation.</li>
  </ol>
</body>
  </html>`;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name && value.length > 0) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function setupCookie(value: string, publicUrl: string): string {
  return `${SETUP_COOKIE}=${encodeURIComponent(value)}; Max-Age=${SETUP_COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax${
    new URL(publicUrl).protocol === "https:" ? "; Secure" : ""
  }`;
}

function clearSetupCookie(publicUrl: string): string {
  return `${SETUP_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${
    new URL(publicUrl).protocol === "https:" ? "; Secure" : ""
  }`;
}
