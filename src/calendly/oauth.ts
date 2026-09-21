import { ApiError } from "../lib/errors.js";
import type { CalendlyTokenResponse, FetchLike } from "./types.js";

export interface CalendlyOAuthOptions {
  authBaseUrl: string;
  clientId: string;
  clientSecret?: string;
  mode: "web" | "native";
  fetchImpl?: FetchLike;
}

export interface AuthorizeUrlInput {
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

export interface ExchangeCodeInput {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

/**
 * Calendly OAuth 2.1 client.
 *
 * - `web` apps authenticate the token endpoint with HTTP Basic (client_id + secret).
 * - `native` apps send client_id in the body.
 * - PKCE (S256) is sent in both modes; Calendly requires S256 for the authorize step.
 * - Refresh tokens are single-use and rotate on every call.
 */
export class CalendlyOAuth {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: CalendlyOAuthOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  buildAuthorizeUrl(input: AuthorizeUrlInput): string {
    const url = new URL(`${this.options.authBaseUrl}/oauth/authorize`);
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("code_challenge", input.codeChallenge);
    return url.toString();
  }

  exchangeCode(input: ExchangeCodeInput): Promise<CalendlyTokenResponse> {
    return this.tokenRequest({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
  }

  refresh(refreshToken: string): Promise<CalendlyTokenResponse> {
    return this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  private async tokenRequest(params: Record<string, string>): Promise<CalendlyTokenResponse> {
    const body = new URLSearchParams(params);
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    if (this.options.mode === "web") {
      const secret = this.options.clientSecret ?? "";
      headers.Authorization =
        "Basic " + Buffer.from(`${this.options.clientId}:${secret}`).toString("base64");
    } else {
      body.set("client_id", this.options.clientId);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.options.authBaseUrl}/oauth/token`, {
        method: "POST",
        headers,
        body: body.toString(),
      });
    } catch (err) {
      throw new ApiError(
        "calendly_error",
        "Could not reach Calendly's token endpoint. Retry shortly.",
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }

    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    if (!res.ok) {
      const error = (json as { error?: string } | undefined)?.error;
      const description =
        (json as { error_description?: string; message?: string } | undefined)?.error_description ??
        (json as { message?: string } | undefined)?.message;
      if (error === "invalid_grant") {
        throw new ApiError(
          "needs_reconnect",
          "Calendly access was revoked or the refresh token was already used. Reconnect Calendly.",
        );
      }
      throw new ApiError(
        res.status >= 500 ? "calendly_error" : "validation_error",
        description ?? `Calendly token request failed (HTTP ${res.status}).`,
        { status: res.status, error },
      );
    }

    return json as CalendlyTokenResponse;
  }
}
