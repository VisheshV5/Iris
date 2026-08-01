/**
 * Founder-initiated outbound calls.
 *
 * Places a Vapi call from the existing trunk number using the SECOND assistant
 * ("Iris Outbound", provisioned by scripts/setup-vapi.ts as state.outboundAssistantId).
 * The specific goal of the call travels as a {{mission}} template variable, the same
 * assistantOverrides.variableValues pattern the inbound bridge uses.
 *
 * CONSENT GUARD: hackathon rules allow calls only to OTP-verified numbers, so every
 * outbound number must be on the VERIFIED_OUTBOUND_NUMBERS allowlist in .env.
 * The guard lives here — at the last hop before the Vapi API — so no future caller of
 * this module can forget it.
 */
import { readFileSync } from "node:fs";
import { env } from "./env.js";
import { markCallRinging } from "./supabase.js";

const VAPI = "https://api.vapi.ai";
const STATE_FILE = "vapi.state.json";

/** Best-effort E.164: founders and Places both hand us loosely formatted US numbers. */
export function normalizeE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d+]/g, "");
  if (!cleaned) return null;
  if (cleaned.startsWith("+")) return cleaned;
  if (/^\d{10}$/.test(cleaned)) return `+1${cleaned}`;
  if (/^1\d{10}$/.test(cleaned)) return `+${cleaned}`;
  return `+${cleaned}`;
}

/** Is this number on the A1 verified-numbers allowlist (VERIFIED_OUTBOUND_NUMBERS)? */
export function isVerifiedOutbound(number: string | null | undefined): boolean {
  const n = normalizeE164(number);
  if (!n) return false;
  return env.verifiedOutboundNumbers.some((v) => normalizeE164(v) === n);
}

/** Human-readable remediation the app can display next to a number_not_verified error. */
export function verificationHowTo(): string {
  return (
    "A1 hackathon rules allow outbound calls only to OTP-verified numbers. " +
    `Verify it first (POST ${env.a1BaseUrl}/api/verified-numbers with the number, then /confirm with the OTP), ` +
    "then add it to VERIFIED_OUTBOUND_NUMBERS in the server's .env (comma-separated E.164) and restart the server."
  );
}

export class NumberNotVerifiedError extends Error {
  readonly code = "number_not_verified";
  constructor(readonly number: string) {
    super(`outbound number ${number} is not on the verified allowlist`);
    this.name = "NumberNotVerifiedError";
  }
}

export type OutboundCallRequest = {
  toNumber: string;
  /** What Iris is calling to accomplish — becomes the {{mission}} prompt variable. */
  mission: string;
  founderName: string;
  company: string;
  calleeName?: string;
};

export async function placeOutboundCall(opts: OutboundCallRequest): Promise<{ callId: string }> {
  if (!env.vapiApiKey) throw new Error("VAPI_API_KEY is not set in .env");

  const to = normalizeE164(opts.toNumber);
  if (!to) throw new Error(`unusable outbound number: "${opts.toNumber}"`);
  if (!isVerifiedOutbound(to)) throw new NumberNotVerifiedError(to);

  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, string>;
  if (!state.phoneNumberId) throw new Error("no phoneNumberId in vapi.state.json — run npm run setup:vapi");
  if (!state.outboundAssistantId) {
    throw new Error("no outboundAssistantId in vapi.state.json — run npm run setup:vapi to provision the Iris Outbound assistant");
  }

  const res = await fetch(`${VAPI}/call`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.vapiApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      assistantId: state.outboundAssistantId,
      phoneNumberId: state.phoneNumberId,
      customer: { number: to, ...(opts.calleeName ? { name: opts.calleeName } : {}) },
      assistantOverrides: {
        variableValues: {
          today: new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Los_Angeles",
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          }).format(new Date()),
          founder_name: opts.founderName,
          company: opts.company,
          mission: opts.mission,
          callee_name: opts.calleeName ?? "there",
          // She dialed this number — without it in context she has been observed
          // escalating mid-call to ask what number to put on the booking.
          callee_number: to,
        },
      },
      metadata: { direction: "outbound", mission: opts.mission },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Vapi outbound call failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const call = (await res.json()) as { id: string };
  // Surface outbound calls in the companion app's live-call card too.
  markCallRinging(call.id, to, "outbound", opts.calleeName ?? null).catch(() => {});
  console.log(`📞 [outbound] call ${call.id} placed to ${to} — mission: ${opts.mission.slice(0, 120)}`);
  return { callId: call.id };
}
