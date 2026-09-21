export type ErrorCode =
  | "validation_error"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "needs_reconnect"
  | "calendly_error"
  | "not_configured"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  needs_reconnect: 409,
  calendly_error: 502,
  not_configured: 503,
  internal: 500,
};

/**
 * Errors are surfaced to the agent and possibly to the user, so messages must be
 * human-readable. `code` is stable for programmatic handling.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown, status?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status ?? STATUS[code];
    this.details = details;
  }

  toJSON(): { error: { code: ErrorCode; message: string; details?: unknown } } {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}
