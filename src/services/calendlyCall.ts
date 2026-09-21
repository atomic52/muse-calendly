import { ApiError } from "../lib/errors.js";
import type { CalendlyApiClient, Method } from "../calendly/client.js";
import type { CalendlyResponse } from "../calendly/types.js";
import type { TokenManager } from "../calendly/tokenManager.js";

/**
 * Authenticated Calendly call with one transparent refresh-and-retry on 401 for reads.
 * Maps every Calendly failure to a stable ApiError with a human-readable message.
 */
export async function callCalendly<T>(
  tokenManager: TokenManager,
  client: CalendlyApiClient,
  connectionId: string,
  method: Method,
  path: string,
  body?: unknown,
): Promise<T> {
  let { accessToken, connection } = await tokenManager.getAccessToken(connectionId);
  let res = await client.request<T>(accessToken, method, path, body);

  // A write may have reached the provider even when its response is ambiguous;
  // never replay it automatically. The caller can retry with an idempotency key.
  if (method === "GET" && res.status === 401 && connection.status === "active") {
    ({ accessToken, connection } = await tokenManager.forceRefresh(connectionId, accessToken));
    res = await client.request<T>(accessToken, method, path, body);
  }

  if (!res.ok) throw mapCalendlyError(res);
  return res.data;
}

export function mapCalendlyError(res: CalendlyResponse<unknown>): ApiError {
  switch (res.status) {
    case 400:
      return new ApiError("validation_error", "Calendly rejected the request.");
    case 401:
      return new ApiError("unauthorized", "Calendly authentication failed. Reconnect Calendly.");
    case 403:
      return new ApiError(
        "forbidden",
        "Calendly denied this action (missing scope or plan restriction).",
      );
    case 404:
      return new ApiError("not_found", "Calendly resource not found.");
    case 429:
      return new ApiError("rate_limited", "Calendly rate limit reached. Retry shortly.", {
        retryAfterSeconds: res.rateLimitResetSeconds,
      });
    default:
      if (res.status >= 500) {
        return new ApiError("calendly_error", `Calendly error (HTTP ${res.status}). Retry shortly.`);
      }
      return new ApiError("calendly_error", `Calendly request failed (HTTP ${res.status}).`);
  }
}
