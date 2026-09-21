import { ApiError } from "../lib/errors.js";
import type { CalendlyApiClient } from "../calendly/client.js";
import type { CalendlyCollection, CalendlyUserResource } from "../calendly/types.js";
import type { TokenManager } from "../calendly/tokenManager.js";
import type { Connection } from "../store/types.js";
import { callCalendly } from "./calendlyCall.js";

export interface BookingInput {
  event_type: string;
  start_time: string;
  invitee: { name: string; email: string; timezone?: string };
  event_guests?: string[];
  location?: { kind: string; location?: string };
  questions_and_answers?: Array<{ question: string; answer: string; position?: number }>;
  tracking?: Record<string, string>;
}

export interface AvailabilityInput {
  eventTypeUuid: string;
  start?: string;
  end?: string;
}

export interface BookingListInput {
  status?: "active" | "canceled";
  minStartTime?: string;
  maxStartTime?: string;
  count?: number;
  pageToken?: string;
}

export interface SchedulingLinkInput {
  eventType: string;
  maxEventCount: number;
}

export class SchedulingService {
  constructor(
    private readonly tokenManager: TokenManager,
    private readonly client: CalendlyApiClient,
    private readonly apiBaseUrl: string,
  ) {}

  async getAccount(connection: Connection): Promise<CalendlyUserResource> {
    const data = await callCalendly<{ resource: CalendlyUserResource }>(
      this.tokenManager,
      this.client,
      connection.id,
      "GET",
      "/users/me",
    );
    return data.resource;
  }

  async listEventTypes(connection: Connection) {
    const organization = this.requireOrganization(connection);
    const data = await callCalendly<CalendlyCollection<EventTypeResource>>(
      this.tokenManager,
      this.client,
      connection.id,
      "GET",
      `/event_types${qs({
        organization,
        user: connection.userUri,
        active: "true",
        count: "100",
      })}`,
    );
    return {
      eventTypes: data.collection.map(mapEventType),
      pagination: data.pagination ?? null,
    };
  }

  async getAvailability(connection: Connection, input: AvailabilityInput) {
    const start = input.start ? new Date(input.start) : new Date();
    const end = input.end ? new Date(input.end) : new Date(start.getTime() + 7 * 86_400_000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw new ApiError("validation_error", "Availability requires a valid, increasing time window.");
    }
    if (end.getTime() - start.getTime() > 31 * 86_400_000) {
      throw new ApiError("validation_error", "Availability window cannot exceed 31 days.");
    }
    const eventTypeUri = `${this.apiBaseUrl}/event_types/${input.eventTypeUuid}`;
    const data = await callCalendly<CalendlyCollection<AvailableTimeResource>>(
      this.tokenManager,
      this.client,
      connection.id,
      "GET",
      `/event_type_available_times${qs({
        event_type: eventTypeUri,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
      })}`,
    );
    return {
      eventType: eventTypeUri,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      slots: data.collection.map((slot) => ({
        startTime: slot.start_time,
        status: slot.status,
        inviteesRemaining: slot.invitees_remaining,
        schedulingUrl: slot.scheduling_url,
      })),
    };
  }

  async createBooking(connection: Connection, body: BookingInput) {
    const data = await callCalendly<{ resource: BookingResource }>(
      this.tokenManager,
      this.client,
      connection.id,
      "POST",
      "/invitees",
      body,
    );
    return mapBooking(data.resource);
  }

  async listBookings(connection: Connection, input: BookingListInput) {
    const organization = this.requireOrganization(connection);
    const data = await callCalendly<CalendlyCollection<ScheduledEventResource>>(
      this.tokenManager,
      this.client,
      connection.id,
      "GET",
      `/scheduled_events${qs({
        organization,
        user: connection.userUri,
        status: input.status,
        min_start_time: input.minStartTime,
        max_start_time: input.maxStartTime,
        count: input.count?.toString(),
        page_token: input.pageToken,
        sort: "start_time:asc",
      })}`,
    );
    return {
      bookings: data.collection.map(mapScheduledEvent),
      pagination: data.pagination ?? null,
    };
  }

  async cancelBooking(connection: Connection, uuid: string, reason?: string) {
    const data = await callCalendly<{ resource?: unknown }>(
      this.tokenManager,
      this.client,
      connection.id,
      "POST",
      `/scheduled_events/${uuid}/cancellation`,
      reason ? { reason } : {},
    );
    return { canceled: true, event: data.resource ?? null };
  }

  async createSchedulingLink(connection: Connection, input: SchedulingLinkInput) {
    const data = await callCalendly<{ resource: SchedulingLinkResource }>(
      this.tokenManager,
      this.client,
      connection.id,
      "POST",
      "/scheduling_links",
      {
        max_event_count: input.maxEventCount,
        owner: input.eventType,
        owner_type: "EventType",
      },
    );
    return {
      bookingUrl: data.resource.booking_url,
      owner: data.resource.owner,
      ownerType: data.resource.owner_type,
    };
  }

  private requireOrganization(connection: Connection): string {
    if (!connection.organizationUri) {
      throw new ApiError("validation_error", "Connection is missing an organization. Reconnect Calendly.");
    }
    return connection.organizationUri;
  }
}

function qs(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, value);
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : "";
}

interface EventTypeResource {
  uri: string;
  name: string;
  slug?: string;
  duration?: number;
  active?: boolean;
  kind?: string;
  scheduling_url?: string;
  description_plain?: string;
}

interface AvailableTimeResource {
  start_time: string;
  status: string;
  invitees_remaining?: number;
  scheduling_url?: string;
}

interface BookingResource {
  uri?: string;
  event?: string;
  status?: string;
  cancel_url?: string;
  reschedule_url?: string;
  start_time?: string;
  end_time?: string;
  invitee?: unknown;
}

interface ScheduledEventResource {
  uri: string;
  name?: string;
  status?: string;
  start_time?: string;
  end_time?: string;
  event_type?: string;
  location?: unknown;
  invitees_counter?: { total?: number; active?: number; limit?: number };
}

interface SchedulingLinkResource {
  booking_url: string;
  owner: string;
  owner_type: string;
}

function mapEventType(resource: EventTypeResource) {
  return {
    uri: resource.uri,
    id: lastSegment(resource.uri),
    name: resource.name,
    slug: resource.slug,
    duration: resource.duration,
    active: resource.active,
    kind: resource.kind,
    schedulingUrl: resource.scheduling_url,
    description: resource.description_plain,
  };
}

function mapScheduledEvent(resource: ScheduledEventResource) {
  return {
    uri: resource.uri,
    id: lastSegment(resource.uri),
    name: resource.name,
    status: resource.status,
    startTime: resource.start_time,
    endTime: resource.end_time,
    eventType: resource.event_type,
    invitees: resource.invitees_counter,
    location: resource.location,
  };
}

function mapBooking(resource: BookingResource) {
  return {
    inviteeUri: resource.uri,
    eventUri: resource.event,
    status: resource.status,
    startTime: resource.start_time,
    endTime: resource.end_time,
    cancelUrl: resource.cancel_url,
    rescheduleUrl: resource.reschedule_url,
    invitee: resource.invitee,
  };
}

function lastSegment(uri: string): string {
  return uri.split("/").filter(Boolean).pop() ?? "";
}
