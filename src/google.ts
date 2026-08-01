/**
 * Google Calendar client for the founder's primary calendar.
 *
 * Auth: the companion app stores the OAuth refresh token on the founder's profile
 * (captured right after the Supabase OAuth redirect — the only moment it is exposed);
 * this module trades it for short-lived access tokens and caches them until expiry.
 * Privacy: only free/busy ever leaves this module for availability questions — event
 * titles and attendees are never fetched.
 */
import { env } from "./env.js";
import { getLatestProfile } from "./supabase.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL = "https://www.googleapis.com/calendar/v3";

export const FOUNDER_TZ = "America/Los_Angeles";
const WORK_START_MIN = 9 * 60; // 9am
const WORK_END_MIN = 18 * 60; // 6pm
const SLOT_STEP_MS = 30 * 60_000;
const SCAN_DAYS = 3;

/** Thrown when there is no stored refresh token or no OAuth client configured. */
export class CalendarNotConnectedError extends Error {
  constructor(reason: string) {
    super(`calendar not connected: ${reason}`);
    this.name = "CalendarNotConnectedError";
  }
}

/** True when a booking attempt could plausibly succeed (config + stored token exist). */
export async function calendarReady(): Promise<boolean> {
  if (!env.googleClientId || !env.googleClientSecret) return false;
  const profile = await getLatestProfile().catch(() => null);
  return Boolean(profile?.google_refresh_token);
}

// Access tokens live ~1h; cache until 60s before expiry. Keyed to the refresh token
// so a founder re-connecting Google (new refresh token) invalidates the cache.
let tokenCache: { accessToken: string; refreshToken: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (!env.googleClientId || !env.googleClientSecret) {
    throw new CalendarNotConnectedError("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set in .env");
  }
  const profile = await getLatestProfile();
  const refreshToken = profile?.google_refresh_token;
  if (!refreshToken) {
    throw new CalendarNotConnectedError("no google_refresh_token on the founder profile — connect Google Calendar in the app");
  }
  if (tokenCache && tokenCache.refreshToken === refreshToken && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return data.access_token;
}

async function calendarFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  const token = await accessToken();
  const res = await fetch(`${CAL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google Calendar ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Busy blocks on the primary calendar between the two instants. */
export async function freeBusy(startIso: string, stopIso: string): Promise<{ start: string; end: string }[]> {
  // Derived from events.list rather than the freebusy endpoint: the app's OAuth
  // grant is calendar.events only, which freebusy.query 403s on but events.list
  // accepts — and this way nobody has to reconnect with broader permissions.
  const params = new URLSearchParams({
    timeMin: new Date(startIso).toISOString(),
    timeMax: new Date(stopIso).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
    fields: "items(start,end,transparency,status)",
  });
  const data = (await calendarFetch("GET", `/calendars/primary/events?${params}`)) as {
    items?: Array<{
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      transparency?: string;
      status?: string;
    }>;
  };
  return (data.items ?? [])
    .filter((e) => e.status !== "cancelled" && e.transparency !== "transparent")
    .map((e) => ({
      // All-day events carry `date` (no time); treat them as spanning the whole day.
      start: e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : ""),
      end: e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00Z` : ""),
    }))
    .filter((b) => b.start && b.end);
}

export async function createEvent(opts: {
  title: string;
  startIso: string;
  endIso: string;
  description: string;
}): Promise<{ id: string; htmlLink: string }> {
  const data = (await calendarFetch("POST", "/calendars/primary/events", {
    summary: opts.title,
    description: opts.description,
    start: { dateTime: new Date(opts.startIso).toISOString() },
    end: { dateTime: new Date(opts.endIso).toISOString() },
  })) as { id: string; htmlLink: string };
  return { id: data.id, htmlLink: data.htmlLink };
}

export async function deleteEvent(eventId: string): Promise<void> {
  await calendarFetch("DELETE", `/calendars/primary/events/${encodeURIComponent(eventId)}`);
}

// Minute-of-day in the founder's timezone, without a date library. ICU can emit
// hour "24" at midnight, hence the modulo.
function founderMinuteOfDay(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: FOUNDER_TZ,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/**
 * The next free slots strictly after the requested time: 30-minute grid, within
 * 9am–6pm in the founder's timezone, scanning up to 3 days out. One freeBusy call
 * covers the whole window, so this is a single round-trip regardless of count.
 */
export async function findAlternatives(requestedIso: string, durationMin: number, count: number): Promise<string[]> {
  const requestedMs = new Date(requestedIso).getTime();
  const durMs = durationMin * 60_000;
  const horizonMs = requestedMs + SCAN_DAYS * 24 * 3600_000;

  const busy = await freeBusy(new Date(requestedMs).toISOString(), new Date(horizonMs + durMs).toISOString());
  const blocks = busy.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));

  const slots: string[] = [];
  // First candidate: the next half-hour boundary strictly after the requested time.
  // Epoch-aligned half hours coincide with wall-clock :00/:30 (offsets are whole hours here).
  for (
    let t = Math.floor(requestedMs / SLOT_STEP_MS + 1) * SLOT_STEP_MS;
    t <= horizonMs && slots.length < count;
    t += SLOT_STEP_MS
  ) {
    const startMin = founderMinuteOfDay(new Date(t));
    if (startMin < WORK_START_MIN || startMin + durationMin > WORK_END_MIN) continue;
    if (blocks.some((b) => t < b.end && t + durMs > b.start)) continue;
    slots.push(new Date(t).toISOString());
  }
  return slots;
}
