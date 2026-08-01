/**
 * POST /iris/command — the founder's natural-language command channel.
 *
 * Body: { text: string, contact?: { name: string, phone: string } }
 * Auth: Authorization: Bearer <Supabase user JWT> — verified against /auth/v1/user.
 *
 * The text is never parsed with regexes or hardcoded names/dates: the A1 gateway
 * (Responses API, non-streaming, no sampling params — see src/shim.ts) turns it into a
 * structured intent via a single forced function call, with today's date in the prompt
 * so "tomorrow at 2" resolves correctly.
 */
import type { Request, Response } from "express";
import { env } from "./env.js";
import { getLatestProfile } from "./supabase.js";
import { FOUNDER_TZ } from "./google.js";
import { findBusiness, type BusinessResult } from "./places.js";
import {
  isVerifiedOutbound,
  normalizeE164,
  placeOutboundCall,
  verificationHowTo,
  NumberNotVerifiedError,
} from "./outbound.js";

// ── Auth ────────────────────────────────────────────────────────────────────

async function verifyUserJwt(authHeader: string | undefined): Promise<{ id: string; email?: string } | null> {
  const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return null;
  try {
    const res = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: env.supabaseAnonKey || env.supabaseServiceRoleKey,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const user = (await res.json()) as { id?: string; email?: string };
    return user?.id ? { id: user.id, email: user.email } : null;
  } catch {
    return null;
  }
}

// ── Intent parsing (LLM, never regex) ───────────────────────────────────────

export type ParsedIntent = {
  intent: "schedule_meeting" | "make_reservation" | "unknown";
  contact_name?: string;
  business_name?: string;
  datetime_iso?: string;
  duration_min?: number;
  party_size?: number;
  notes?: string;
};

const INTENT_TOOL = {
  type: "function",
  name: "set_intent",
  description: "Record the structured interpretation of the founder's instruction. Call exactly once.",
  parameters: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        enum: ["schedule_meeting", "make_reservation", "unknown"],
        description:
          "schedule_meeting: call a person to arrange a meeting. make_reservation: call a restaurant/venue to book a table or slot. unknown: anything else.",
      },
      contact_name: { type: "string", description: "The person to meet, exactly as the founder named them." },
      business_name: { type: "string", description: "The restaurant or venue to call, exactly as the founder named it." },
      datetime_iso: {
        type: "string",
        description: `Proposed start as full ISO 8601 with timezone offset (founder timezone ${FOUNDER_TZ}). Omit if no time was given.`,
      },
      duration_min: { type: "number", description: "Meeting length in minutes, if stated. Default is handled elsewhere." },
      party_size: { type: "number", description: "Number of people for a reservation, if stated." },
      notes: { type: "string", description: "Any other constraint or context the caller should honor (topic, 'outdoor seating', etc.)." },
    },
    required: ["intent"],
  },
};

async function parseCommand(text: string): Promise<ParsedIntent> {
  const nowSpoken = new Intl.DateTimeFormat("en-US", {
    timeZone: FOUNDER_TZ,
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date());

  const system = [
    "You turn a founder's spoken instruction to their AI assistant into a structured intent.",
    `Current date and time: ${nowSpoken} (${FOUNDER_TZ}).`,
    `Resolve relative dates ("tomorrow", "Friday at 7") against that moment and emit datetime_iso as full ISO 8601 with the correct ${FOUNDER_TZ} UTC offset. Omit datetime_iso entirely when no time was mentioned — never invent one.`,
    "Names go through verbatim: copy the founder's exact wording for people and businesses, never normalize or guess spellings.",
    "Call the set_intent tool exactly once. If the instruction is neither scheduling a meeting nor making a reservation, use intent \"unknown\".",
  ].join("\n");

  // Same shape src/shim.ts sends the gateway: /responses, non-streaming, no
  // temperature/top_p (the gateway 400s on sampling params).
  const res = await fetch(`${env.aiGatewayBaseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.aiGatewayKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.irisModel,
      input: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
      tools: [INTENT_TOOL],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`AI gateway ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const response = (await res.json()) as {
    output?: Array<{
      type?: string;
      name?: string;
      arguments?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };

  for (const item of response.output ?? []) {
    if (item.type === "function_call" && item.name === "set_intent") {
      return sanitizeIntent(safeParse(item.arguments ?? "{}"));
    }
  }
  // Some models answer in text despite the tool. Salvage a JSON object if one is there.
  const textOut = (response.output ?? [])
    .flatMap((i) => (i.type === "message" ? (i.content ?? []) : []))
    .map((p) => (p.type === "output_text" ? (p.text ?? "") : ""))
    .join("");
  const jsonMatch = textOut.match(/\{[\s\S]*\}/);
  if (jsonMatch) return sanitizeIntent(safeParse(jsonMatch[0]));
  return { intent: "unknown" };
}

function sanitizeIntent(raw: unknown): ParsedIntent {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const intent = o.intent === "schedule_meeting" || o.intent === "make_reservation" ? o.intent : "unknown";
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined);
  const datetime = str(o.datetime_iso);
  return {
    intent,
    contact_name: str(o.contact_name),
    business_name: str(o.business_name),
    datetime_iso: datetime && !Number.isNaN(Date.parse(datetime)) ? datetime : undefined,
    duration_min: num(o.duration_min),
    party_size: num(o.party_size),
    notes: str(o.notes),
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ── Mission text ────────────────────────────────────────────────────────────

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

function buildMission(
  parsed: ParsedIntent,
  founderName: string,
  company: string,
  calleeName: string,
  business: BusinessResult | null,
): string {
  const notes = parsed.notes ? ` Additional context from ${founderName}: ${parsed.notes}.` : "";

  if (parsed.intent === "make_reservation") {
    const where = business?.name ?? parsed.business_name ?? "the restaurant";
    const party = parsed.party_size ?? 2;
    const when = parsed.datetime_iso
      ? `on ${speakWhen(parsed.datetime_iso)} (${parsed.datetime_iso})`
      : "at a time you negotiate with them (no specific time was given — ask what they have)";
    return (
      `Book a table for ${party} at ${where} under the name ${founderName}, ${when}.` +
      ` If that exact time is unavailable, ask for the nearest options and check each against check_availability before agreeing — ${founderName} must actually be free.` +
      ` Once the reservation is confirmed, call book_meeting with the agreed time, duration 90 minutes, and a title like "Reservation at ${where} (party of ${party})" so it lands on ${founderName}'s calendar. Then recap the reservation back to them and end the call.` +
      notes
    );
  }

  // schedule_meeting
  const who = calleeName || parsed.contact_name || "the person you are calling";
  const duration = parsed.duration_min ?? 30;
  const when = parsed.datetime_iso
    ? `${founderName} proposes ${speakWhen(parsed.datetime_iso)} (${parsed.datetime_iso}). Verify it with check_availability before presenting it as certain, then open by proposing it.`
    : `No time was proposed — ask what works for them and negotiate using check_availability.`;
  return (
    `Arrange a ${duration}-minute meeting between ${founderName} of ${company} and ${who}. ${when}` +
    ` When you and ${who} agree on a time, confirm the full date, time, and timezone out loud, then call book_meeting with ${who}'s name and this number. Then recap and end the call.` +
    notes
  );
}

// ── Endpoint ────────────────────────────────────────────────────────────────

export async function irisCommand(req: Request, res: Response): Promise<void> {
  const user = await verifyUserJwt(req.header("authorization"));
  if (!user) {
    res.status(401).json({ error: "unauthorized", detail: "Authorization: Bearer <supabase user JWT> required" });
    return;
  }

  const text = String(req.body?.text ?? "").trim();
  if (!text) {
    res.status(400).json({ error: "text_required" });
    return;
  }
  const contact = (req.body?.contact ?? null) as { name?: string; phone?: string } | null;

  try {
    const parsed = await parseCommand(text);
    console.log(`🎙️ [command] "${text.slice(0, 120)}" -> ${JSON.stringify(parsed)}`);

    if (parsed.intent === "unknown") {
      res.status(422).json({
        error: "unrecognized_command",
        parsed,
        hint: 'Try "schedule a 30-minute meeting with <name> tomorrow at 2pm" or "book a table for 4 at <restaurant> on Friday at 7".',
      });
      return;
    }

    const profile = await getLatestProfile().catch(() => null);
    const founderName = profile?.full_name || "the founder";
    const company = profile?.company || "their company";

    // Resolve who to dial. Meetings: the app resolves contacts on-device and sends the
    // matched card. Reservations: fall back to Places when no number was provided.
    // (profiles has no `location` column yet, so the Places query is not location-biased.)
    let toNumber = normalizeE164(contact?.phone ?? null);
    let calleeName = contact?.name || parsed.contact_name || parsed.business_name || "";
    let business: BusinessResult | null = null;

    if (!toNumber && parsed.intent === "make_reservation") {
      if (!parsed.business_name) {
        res.status(422).json({ error: "business_name_missing", parsed });
        return;
      }
      const hit = await findBusiness(parsed.business_name);
      if ("error" in hit && !env.restaurantDemoNumber) {
        res.status(502).json({ error: "business_lookup_failed", detail: hit.error, parsed });
        return;
      }
      business = "error" in hit ? { name: parsed.business_name, phone: null, address: null } : hit;
      // Hackathon consent rules mean we can't cold-call real venues; when a demo
      // stand-in line is configured, every reservation dials it while keeping the
      // real business's name/address in the mission for realism.
      if (env.restaurantDemoNumber) {
        toNumber = env.restaurantDemoNumber;
      } else if (business.phone) {
        toNumber = business.phone;
      } else {
        res.status(404).json({ error: "business_has_no_phone", business, parsed });
        return;
      }
      if (!calleeName) calleeName = business.name;
    }

    if (!toNumber) {
      // The iOS app keys on error="contact_required" + top-level contact_name to run
      // its on-device Contacts search and re-POST with {name, phone}.
      if (parsed.contact_name) {
        res.status(422).json({
          error: "contact_required",
          contact_name: parsed.contact_name,
          needsContact: { name: parsed.contact_name },
          parsed,
        });
        return;
      }
      res.status(422).json({
        error: "contact_phone_required",
        parsed,
        hint: "Say who to call by name, or include contact: { name, phone }.",
      });
      return;
    }

    if (!isVerifiedOutbound(toNumber)) {
      res.status(403).json({ error: "number_not_verified", number: toNumber, howTo: verificationHowTo() });
      return;
    }

    const mission = buildMission(parsed, founderName, company, calleeName, business);
    const call = await placeOutboundCall({ toNumber, mission, founderName, company, calleeName: calleeName || undefined });

    res.json({
      ok: true,
      intent: parsed.intent,
      to: toNumber,
      callee: calleeName || null,
      business,
      mission,
      vapi_call_id: call.callId,
    });
  } catch (err) {
    if (err instanceof NumberNotVerifiedError) {
      res.status(403).json({ error: "number_not_verified", number: err.number, howTo: verificationHowTo() });
      return;
    }
    console.error("[command] failed:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "command_failed", detail: err instanceof Error ? err.message : String(err) });
  }
}
