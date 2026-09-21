export type FetchLike = typeof fetch;

export interface CalendlyTokenResponse {
  token_type: string;
  access_token: string;
  refresh_token: string;
  scope?: string;
  created_at: number;
  expires_in: number;
  owner: string;
  organization: string;
}

export interface CalendlyUserResource {
  uri: string;
  name: string;
  email: string;
  timezone: string;
  scheduling_url?: string;
  current_organization: string;
  avatar_url?: string;
}

export interface CalendlyCollection<T> {
  collection: T[];
  pagination?: {
    count: number;
    next_page?: string | null;
    next_page_token?: string | null;
  };
}

export interface CalendlyResponse<T> {
  status: number;
  ok: boolean;
  data: T;
  rateLimitResetSeconds?: number;
}
