import { describe, expect, it, vi } from "vitest";
import { CalendlyApiClient } from "../src/calendly/client.js";
import { callCalendly, mapCalendlyError } from "../src/services/calendlyCall.js";
import type { CalendlyResponse } from "../src/calendly/types.js";

describe("Calendly call policy", () => {
  it("does not refresh and replay writes after a 401", async () => {
    const client = { request: vi.fn().mockResolvedValue({ status: 401, ok: false, data: null }) } as never;
    const tokenManager = {
      getAccessToken: vi.fn().mockResolvedValue({
        accessToken: "access",
        connection: { id: "c1", status: "active" },
      }),
      forceRefresh: vi.fn(),
    } as never;

    await expect(callCalendly(tokenManager, client, "c1", "POST", "/invitees", {})).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(tokenManager.forceRefresh).not.toHaveBeenCalled();
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("does not expose the provider response body in errors", () => {
    const response: CalendlyResponse<unknown> = {
      status: 400,
      ok: false,
      data: { message: "invitee email", email: "ada@example.com" },
    };
    const error = mapCalendlyError(response);
    expect(error.toJSON()).toEqual({
      error: { code: "validation_error", message: "Calendly rejected the request." },
    });
  });

  it("keeps the HTTP adapter single-request", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "secret" }), { status: 400 }));
    const client = new CalendlyApiClient({ apiBaseUrl: "https://api.test", fetchImpl });
    const result = await client.request("access", "POST", "/invitees", {});
    expect(result.status).toBe(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
