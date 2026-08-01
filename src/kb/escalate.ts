/**
 * Escalation. The hard constraint here is timing: a human takes tens of seconds to
 * answer, and any synchronous tool call would have timed out long before that. So the
 * tool returns a hold instruction immediately, and the owner's answer is injected into
 * the still-live call later through Vapi's call-control channel.
 */
import { randomUUID } from "node:crypto";
import { supabase } from "../supabase.js";
import { env } from "../env.js";
import { learnAlias } from "./store.js";

const VAPI = "https://api.vapi.ai";

// ── Hold management ─────────────────────────────────────────────────────────
// While an escalation is pending on a live call the caller is sitting in silence.
// Reassure them every ~20s; at 75s total give up, tell Iris to take a message,
// and mark the row expired so the app stops showing it as urgent.

const REASSURE_INTERVAL_MS = 20_000;
const HOLD_TIMEOUT_MS = 75_000;

const REASSURANCE_LINES = [
  "Thanks so much for holding — just another moment.",
  "Still with you — thank you for your patience, almost there.",
  "Thanks for waiting — I'm still checking on that for you.",
];

type Hold = {
  controlUrl: string;
  reassureTimer: NodeJS.Timeout;
  timeoutTimer: NodeJS.Timeout;
  reassureIndex: number;
};

// One hold per call, keyed by Vapi call id: a second escalation on the same call
// must not double up the reassurance track.
const holds = new Map<string, Hold>();

function startHold(vapiCallId: string, controlUrl: string): void {
  if (holds.has(vapiCallId)) return;

  const hold: Hold = {
    controlUrl,
    reassureIndex: 0,
    reassureTimer: setInterval(() => {
      const line = REASSURANCE_LINES[hold.reassureIndex++ % REASSURANCE_LINES.length];
      postControl(controlUrl, { type: "say", content: line }).catch(() => {
        // The call is probably over; stop poking a dead control URL.
        endHoldsForCall(vapiCallId);
      });
    }, REASSURE_INTERVAL_MS),
    timeoutTimer: setTimeout(() => void holdTimedOut(vapiCallId, controlUrl), HOLD_TIMEOUT_MS),
  };
  holds.set(vapiCallId, hold);
}

/** Cancel hold timers for a call. Safe to call for calls with no hold. */
export function endHoldsForCall(vapiCallId: string | null | undefined): void {
  if (!vapiCallId) return;
  const hold = holds.get(vapiCallId);
  if (!hold) return;
  clearInterval(hold.reassureTimer);
  clearTimeout(hold.timeoutTimer);
  holds.delete(vapiCallId);
}

async function holdTimedOut(vapiCallId: string, controlUrl: string): Promise<void> {
  endHoldsForCall(vapiCallId);

  // Expire every still-pending escalation on this call, but only those: if the owner
  // answered in the meantime (status='answered'), leave the row alone and say nothing —
  // the answer path already spoke.
  const { data, error } = await supabase
    .from("kb_escalations")
    .update({ status: "expired" })
    .eq("vapi_call_id", vapiCallId)
    .eq("status", "pending")
    .is("delivered_at", null)
    .select("id");

  if (error) return console.error("[kb] hold-timeout expiry failed:", error.message);
  if (!data?.length) return;

  try {
    await postControl(controlUrl, {
      type: "say",
      content: "I couldn't reach them just now — let me take your details and have them call you back.",
    });
    await postControl(controlUrl, {
      type: "add-message",
      message: {
        role: "system",
        content:
          'The escalation to the team timed out — no answer is coming during this call. The line "I couldn\'t reach them just now — let me take your details and have them call you back" was just spoken to the caller. Stop waiting: take their name, callback number, and message as normal. Never guess at the original question.',
      },
      triggerResponseEnabled: false,
    });
    console.log(`⌛ [escalation] hold on call ${vapiCallId} timed out after ${HOLD_TIMEOUT_MS / 1000}s — Iris is taking a message`);
  } catch (err) {
    console.error("[kb] hold-timeout injection failed:", err instanceof Error ? err.message : err);
  }
}

export type EscalationInput = {
  vapiCallId: string | null;
  callerNumber: string | null;
  question: string;
  reason: string;
  contextForWearer: string | null;
  suggested: string | null;
  suggestedEntryId: string | null;
};

/**
 * Synchronous by design. The row is written and the wearer alerted on a background
 * promise; the caller of this function must not wait for either.
 */
export function raiseEscalation(input: EscalationInput): string {
  const id = randomUUID();

  void (async () => {
    // The control URL is what lets us speak into this call minutes from now. Fetch it
    // while the call is definitely still up rather than when the owner finally replies.
    const controlUrl = input.vapiCallId ? await fetchControlUrl(input.vapiCallId) : null;

    const { error } = await supabase.from("kb_escalations").insert({
      id,
      vapi_call_id: input.vapiCallId,
      control_url: controlUrl,
      caller_number: input.callerNumber,
      question: input.question,
      reason: input.reason,
      context_for_wearer: input.contextForWearer,
      suggested_answer: input.suggested,
      suggested_entry_id: input.suggestedEntryId,
      status: "pending",
    });

    if (error) return console.error("[kb] escalation insert failed:", error.message);

    // The caller is now holding on a live line: keep them company, and give up
    // gracefully if the owner never answers.
    if (input.vapiCallId && controlUrl) startHold(input.vapiCallId, controlUrl);

    // The companion app is subscribed to this table, so the insert above is itself the
    // wearer notification. Logged here so the behaviour is visible in the server output
    // during a demo.
    console.log(
      `🔔 [escalation] "${input.question}" (${input.reason})` +
        (input.suggested ? ` — draft ready: "${input.suggested}"` : " — no draft available") +
        (input.contextForWearer ? " — with wearer-only context" : ""),
    );
  })().catch((err) => console.error("[kb] escalation failed:", err));

  return id;
}

async function fetchControlUrl(callId: string): Promise<string | null> {
  if (!env.vapiApiKey) return null;
  try {
    const res = await fetch(`${VAPI}/call/${callId}`, {
      headers: { Authorization: `Bearer ${env.vapiApiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const call = (await res.json()) as { monitor?: { controlUrl?: string } };
    return call.monitor?.controlUrl ?? null;
  } catch {
    return null;
  }
}

export type DeliveryResult = "delivered" | "already-delivered" | "no-control-url" | "not-found" | "failed";

/**
 * Speak the owner's answer into the live call.
 *
 * The claim on `delivered_at` is a conditional update, so two triggers racing (the
 * realtime subscription and a direct HTTP call, say) cannot both make Iris say it.
 */
export async function deliverAnswer(escalationId: string, answer: string): Promise<DeliveryResult> {
  const { data, error } = await supabase
    .from("kb_escalations")
    .update({ delivered_at: new Date().toISOString(), status: "answered" })
    .eq("id", escalationId)
    .is("delivered_at", null)
    .select("control_url,question,vapi_call_id,suggested_answer,suggested_entry_id")
    .maybeSingle();

  if (error) {
    console.error("[kb] delivery claim failed:", error.message);
    return "failed";
  }
  if (!data) return "already-delivered";

  // The owner answered: stop the hold track before anything else, and learn from the
  // answer regardless of whether the call is still up — knowledge outlives the call.
  endHoldsForCall(data.vapi_call_id);
  ingestOwnerAnswer(
    { id: escalationId, question: data.question, suggested_answer: data.suggested_answer, suggested_entry_id: data.suggested_entry_id },
    answer,
  );

  if (!data.control_url) {
    console.warn(`[kb] escalation ${escalationId} answered but the call had no control URL (already ended?)`);
    return "no-control-url";
  }

  try {
    await postControl(data.control_url, { type: "say", content: answer });
    // Keep the model's view of the conversation honest, or it may answer the same
    // question again a turn later. Not spoken — context only.
    await postControl(data.control_url, {
      type: "add-message",
      message: {
        role: "system",
        content: `The team has answered "${data.question}". Their answer was just spoken to the caller: "${answer}". Do not repeat it; continue the call from here.`,
      },
      triggerResponseEnabled: false,
    });
    console.log(`💬 [escalation] answer delivered into call: "${answer}"`);
    return "delivered";
  } catch (err) {
    console.error("[kb] control-url say failed:", err instanceof Error ? err.message : err);
    return "failed";
  }
}

// ── KB learning ─────────────────────────────────────────────────────────────

type IngestSource = {
  id: string;
  question: string;
  suggested_answer: string | null;
  suggested_entry_id: string | null;
};

/**
 * Turn a delivered owner answer into a PROPOSED kb entry, never an approved one.
 *
 * The owner answered ONE caller's question; that is not the same act as approving a
 * fact for every future caller — their answer may have been specific to that caller's
 * situation. The entry lands as status='proposed', and `confirmed_accurate` /
 * `confirmed_shareable` are deliberately left NULL: the DB constraint
 * `kb_publish_requires_both_answers` exists precisely so only a human answering those
 * two questions can publish. Do not "fix" this by setting them in code.
 *
 * The caller's verbatim wording IS safe to auto-accept — as an alias. A wrong alias
 * costs one clarifying question; a wrong published answer costs a caller being told
 * something false.
 */
function ingestOwnerAnswer(esc: IngestSource, answer: string): void {
  const question = esc.question.trim();
  const spoken = answer.trim();
  if (!question || !spoken) return;

  void (async () => {
    const { data, error } = await supabase
      .from("kb_entries")
      .insert({
        canonical_question: question,
        // The caller's original wording, verbatim — proven by a human answering it.
        aliases: [question],
        answer_spoken: spoken,
        // Q&A verbatim, so a reviewer promoting this entry sees exactly what was said
        // to whom even if the spoken answer gets tidied up later.
        answer_text: [
          "Learned from a live-call escalation (owner's answer, delivered to the caller).",
          `Q (caller, verbatim): "${question}"`,
          `A (owner, verbatim): "${spoken}"`,
        ].join("\n"),
        tags: ["from_escalation"],
        scope: "organization",
        status: "proposed", // NEVER 'approved' — publishing requires a human review
        source_reference: `kb_escalation:${esc.id}`,
      })
      .select("id")
      .maybeSingle();

    if (error) return console.error("[kb] escalation ingest failed:", error.message);
    console.log(`📚 [kb-learn] owner's answer saved as PROPOSED entry ${data?.id ?? "?"} — awaiting the two-question review`);

    // If the owner approved the pre-filled draft verbatim, the caller's wording is also
    // a confirmed alias for the entry the draft came from.
    if (esc.suggested_entry_id && esc.suggested_answer && spoken === esc.suggested_answer.trim()) {
      learnAlias(esc.suggested_entry_id, question);
    }
  })().catch((err) => console.error("[kb] escalation ingest failed:", err));
}

async function postControl(controlUrl: string, payload: unknown): Promise<void> {
  const res = await fetch(controlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`control ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/**
 * Watch for the owner answering from the companion app.
 *
 * Deliberately decoupled: the app just writes `owner_answer` to the row it already has
 * permission to update, and this picks it up. No new endpoint for the app to call and
 * no shared interface to keep in sync.
 */
export function watchForOwnerAnswers(): void {
  supabase
    .channel("kb-escalations")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "kb_escalations" },
      (payload) => {
        const row = payload.new as { id: string; owner_answer: string | null; delivered_at: string | null };
        if (!row.owner_answer || row.delivered_at) return;
        void deliverAnswer(row.id, row.owner_answer);
      },
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") console.log("[kb] watching for owner answers on kb_escalations");
    });
}
