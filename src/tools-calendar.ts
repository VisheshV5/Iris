/**
 * Vapi calendar tools: check_availability and book_meeting.
 *
 * Separate route from /vapi/tools so booking changes can never destabilize the KB
 * path. Same conventions, though: the payload parsing matches src/tools.ts exactly,
 * and every `spoken` field is an INSTRUCTION ("Say this, as written: …"), never a
 * bare answer — handing the model a naked sentence leaves it to decide whether to
 * use it. Privacy: responses carry free/busy only; never why a slot is taken.
 */
import type { Request, Response } from "express";
import { readFileSync } from "node:fs";
import { env } from "./env.js";
import { getLatestProfile } from "./supabase.js";
import { calendarReady, createEvent, findAlternatives, freeBusy, CalendarNotConnectedError, FOUNDER_TZ } from "./google.js";

type ToolContext = { callId: string | null; callerNumber: string | null };

const MAX_ALTERNATIVES = 2;

// "Tuesday, August 4 at 2:00 PM Pacific" — how a slot is spoken to a caller.
function speakWhen(iso: string): string {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: FOUNDER_TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
  return `${formatted} Pacific`;
}

const NOT_CONNECTED = JSON.stringify({
  free: false,
  alternatives: [],
  spoken:
    'The calendar isn\'t connected, so you cannot check or book anything. Say something close to: "I can\'t get to the calendar right now — let me take your details and have someone call you back to set that up." Then take a message as normal. Do not guess at availability.',
});

const CALENDAR_ERROR = JSON.stringify({
  free: false,
  alternatives: [],
  spoken:
    'The calendar could not be reached just now. Say something close to: "I\'m having trouble reaching the calendar — let me take your details and have someone call you back to schedule." Then take a message as normal. Do not guess at availability and do not claim anything was booked.',
});

// Outbound calls invert the calendar's role: the founder personally chose the
// proposed time, so a missing calendar link must never stall the negotiation —
// and the callee should never hear about calendar plumbing at all.
const OUTBOUND_NOT_CONNECTED = JSON.stringify({
  free: true,
  alternatives: [],
  spoken:
    "The founder's calendar isn't linked, but that does NOT block this call — the proposed time came from the founder directly, so treat it as available. Never mention calendars, systems, or technical issues. If they agree to the proposed time, confirm it verbally and say the founder will send a calendar invite to lock it in. If they counter-propose a time, accept it tentatively: say you'll pencil that in and the founder will confirm shortly. Do not call book_meeting again on this call.",
});

let cachedOutboundAssistantId: string | null | undefined;
function outboundAssistantId(): string | null {
  if (cachedOutboundAssistantId === undefined) {
    try {
      cachedOutboundAssistantId =
        (JSON.parse(readFileSync("vapi.state.json", "utf8")) as { outboundAssistantId?: string }).outboundAssistantId ??
        null;
    } catch {
      cachedOutboundAssistantId = null;
    }
  }
  return cachedOutboundAssistantId;
}

function isOutboundCall(message: { call?: { assistantId?: string }; assistant?: { id?: string } }): boolean {
  const id = message.call?.assistantId ?? message.assistant?.id;
  return !!id && id === outboundAssistantId();
}

const badDatetime = (toolName: string) =>
  JSON.stringify({
    free: false,
    alternatives: [],
    spoken: `No usable date and time was supplied. Ask the caller for the exact day and time they want, then call ${toolName} again with a full ISO datetime.`,
  });

// ── Tools ───────────────────────────────────────────────────────────────────

async function checkAvailability(args: Record<string, unknown>, outbound: boolean): Promise<string> {
  const datetimeIso = String(args?.datetime_iso ?? "").trim();
  const durationMin = Math.max(1, Number(args?.duration_min) || 30);
  const requested = new Date(datetimeIso);
  if (!datetimeIso || Number.isNaN(requested.getTime())) return badDatetime("check_availability");
  if (!(await calendarReady())) return outbound ? OUTBOUND_NOT_CONNECTED : NOT_CONNECTED;

  const startMs = requested.getTime();
  const endIso = new Date(startMs + durationMin * 60_000).toISOString();
  const busy = await freeBusy(requested.toISOString(), endIso);
  const free = !busy.some((b) => startMs < Date.parse(b.end) && startMs + durationMin * 60_000 > Date.parse(b.start));

  if (free) {
    return JSON.stringify({
      free: true,
      alternatives: [],
      spoken: `The slot is open. Say this, as written: "Good news — ${speakWhen(requested.toISOString())} is open. Shall I book it?" Do not book until the caller confirms the exact date, time, and timezone.`,
    });
  }

  const alternatives = await findAlternatives(requested.toISOString(), durationMin, MAX_ALTERNATIVES);
  const spoken =
    alternatives.length > 0
      ? `That time is taken. Offer ONLY these alternatives, nothing else, and never say why the time is busy. Say this, as written: "I'm sorry, that time isn't available. I could do ${alternatives
          .map(speakWhen)
          .join(", or ")} — would either of those work?" If neither works, say the team will call back to schedule and take a normal message.`
      : `That time is taken and no nearby slot is open in the next few days. Never say why. Say something close to: "I'm sorry, that time isn't available and the next few days are quite full — let me take your details and have someone call you back to find a time." Then take a message as normal.`;

  return JSON.stringify({ free: false, alternatives, spoken });
}

async function bookMeeting(args: Record<string, unknown>, ctx: ToolContext, outbound: boolean): Promise<string> {
  const datetimeIso = String(args?.datetime_iso ?? "").trim();
  const durationMin = Math.max(1, Number(args?.duration_min) || 30);
  const callerName = String(args?.caller_name ?? "").trim();
  const callbackNumber = String(args?.callback_number ?? "").trim();
  // Title is composed server-side from the founder's perspective — it's THEIR
  // calendar, so the other party's name goes in the title, never the founder's own.
  const title = callerName ? `Meeting with ${callerName}` : String(args?.title ?? "").trim() || "Meeting booked by Iris";
  const requested = new Date(datetimeIso);
  if (!datetimeIso || Number.isNaN(requested.getTime())) return badDatetime("book_meeting");
  if (!(await calendarReady())) return outbound ? OUTBOUND_NOT_CONNECTED : NOT_CONNECTED;

  const startIso = requested.toISOString();
  const endIso = new Date(requested.getTime() + durationMin * 60_000).toISOString();
  const event = await createEvent({
    title,
    startIso,
    endIso,
    description: [
      "Booked by Iris during an inbound call.",
      `Caller: ${callerName || "(name not captured)"}`,
      `Callback: ${callbackNumber || ctx.callerNumber || "(no number captured)"}`,
      ctx.callId ? `Call id: ${ctx.callId}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  });

  const when = speakWhen(startIso);
  // SMS failures must not unwind a booking that already exists on the calendar.
  smsFounder(`Iris booked: ${title}, ${when} (${callbackNumber || ctx.callerNumber || "no number"})`).catch(
    (err) => console.error("[calendar] founder SMS failed:", err instanceof Error ? err.message : err),
  );
  // Confirmation to the other party too (only delivers if their number is
  // OTP-verified with A1 — otherwise it fails and logs, never blocks).
  const otherParty = e164(callbackNumber) || e164(ctx.callerNumber);
  if (otherParty) {
    const profile = await getLatestProfile().catch(() => null);
    const founderName = profile?.full_name || "the founder";
    sendSms(otherParty, `Confirmed: meeting with ${founderName}${profile?.company ? ` (${profile.company})` : ""} — ${when}.`).catch(
      (err) => console.error("[calendar] other-party SMS failed:", err instanceof Error ? err.message : err),
    );
  }

  console.log(`📅 [calendar] booked "${title}" at ${when} (event ${event.id})`);
  return JSON.stringify({
    booked: true,
    event_id: event.id,
    spoken: `The meeting is booked. Say this, as written: "You're all set — ${when}. A confirmation has been sent." Do not mention the calendar system, the event link, or anything else on the calendar.`,
  });
}

// A1 hackathon SMS. Bodies capped at 160 chars (single segment); numbers normalized
// to E.164. A1 only delivers to OTP-verified numbers — undeliverable ones just log.
function e164(raw: string | null | undefined): string {
  let n = (raw ?? "").replace(/[^\d+]/g, "");
  if (/^\d{10}$/.test(n)) n = `+1${n}`;
  if (/^1\d{10}$/.test(n)) n = `+${n}`;
  return n;
}

async function sendSms(to: string, body: string): Promise<void> {
  const res = await fetch(`${env.a1BaseUrl}/api/sms`, {
    method: "POST",
    headers: { "X-Team-Key": env.a1TeamKey, "Content-Type": "application/json" },
    body: JSON.stringify({ to, body: body.slice(0, 160) }),
  });
  if (!res.ok) throw new Error(`A1 SMS to ${to} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  console.log(`📨 [calendar] booking SMS sent to ${to}`);
}

async function smsFounder(body: string): Promise<void> {
  const profile = await getLatestProfile().catch(() => null);
  const to = e164(profile?.phone) || e164(env.wearerPhone);
  if (!to) {
    console.log("[calendar] no founder phone on file — skipping booking SMS");
    return;
  }
  await sendSms(to, body);
}

// ── Endpoint ────────────────────────────────────────────────────────────────

export async function vapiCalendarTools(req: Request, res: Response): Promise<void> {
  const message = req.body?.message;
  if (message?.type !== "tool-calls") {
    res.json({ results: [] });
    return;
  }

  const ctx: ToolContext = {
    callId: message.call?.id ?? null,
    callerNumber: message.call?.customer?.number ?? null,
  };

  const toolCalls: Array<{ id: string; name?: string; function?: { name?: string; arguments?: unknown } }> =
    message.toolCallList ?? message.toolCalls ?? [];

  const results = await Promise.all(
    toolCalls.map(async (tc) => {
      const name = tc.name ?? tc.function?.name ?? "";
      const raw = (tc as { arguments?: unknown }).arguments ?? tc.function?.arguments ?? {};
      const args = (typeof raw === "string" ? safeParse(raw) : raw) as Record<string, unknown>;

      const outbound = isOutboundCall(message);
      try {
        if (name === "check_availability") return { toolCallId: tc.id, result: await checkAvailability(args, outbound) };
        if (name === "book_meeting") return { toolCallId: tc.id, result: await bookMeeting(args, ctx, outbound) };
        return {
          toolCallId: tc.id,
          result: `[UNKNOWN TOOL "${name}"] Do not claim anything was checked or booked. Take a message instead.`,
        };
      } catch (err) {
        // A failure here must never become an invented calendar. Fail closed, loudly.
        console.error(`[calendar] tool ${name} failed:`, err instanceof Error ? err.message : err);
        if (err instanceof CalendarNotConnectedError) {
          return { toolCallId: tc.id, result: isOutboundCall(message) ? OUTBOUND_NOT_CONNECTED : NOT_CONNECTED };
        }
        return { toolCallId: tc.id, result: CALENDAR_ERROR };
      }
    }),
  );

  res.json({ results });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
