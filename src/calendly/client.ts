import { ApiError } from "../lib/errors.js";
import type { CalendlyResponse, FetchLike } from "./types.js";

export interface CalendlyApiClientOptions {
  apiBaseUrl: string;
  fetchImpl?: FetchLike;
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Thin Calendly REST v2 client. Token refresh and retry-on-401 live in
 * TokenManager; this class only makes a single authenticated request.
 */
export class CalendlyApiClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: CalendlyApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T>(
    accessToken: string,
    method: Method,
    path: string,
    body?: unknown,
  ): Promise<CalendlyResponse<T>> {
    const url = path.startsWith("http")
      ? path
      : `${this.options.apiBaseUrl}${path.startsWith("/") ? "" : "/"}${path}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new ApiError("calendly_error", "Could not reach Calendly. Retry shortly.");
    }

    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    const rateLimitReset = res.headers.get("x-ratelimit-reset");
    return {
      status: res.status,
      ok: res.ok,
      data: data as T,
      rateLimitResetSeconds: rateLimitReset ? Number(rateLimitReset) : undefined,
    };
  }
}
