/**
 * Vapi custom-tool endpoint.
 *
 * The knowledge base is exposed as a function call rather than uploaded to Vapi's
 * file-based KB on purpose. A flat file carries no scope, no confidence floor, no
 * disclosure level and no effective dates, and leaves no record of which entry produced
 * an answer — so an unapproved or contact-scoped fact becomes retrievable by anyone who
 * phrases a question well. Keeping retrieval here makes "this may not be spoken" a
 * structural guarantee instead of a request in a prompt.
 *
 * Every response is an INSTRUCTION describing what the assistant is permitted to do.
 * Handing the model a naked answer string would leave it to decide whether to use it.
 */
import type { Request, Response } from "express";
import { decide } from "./kb/gate.js";
import { learnAlias, logUsage, recordGap } from "./kb/store.js";
import { gapKey } from "./kb/text.js";
import { raiseEscalation } from "./kb/escalate.js";

type ToolContext = { callId: string | null; callerNumber: string | null };

type CallState = {
  clarifications: number;
  /** Set while a clarifying question is outstanding, so the reply can teach an alias. */
  pending?: { originalQuestion: string; optionIds: string[] };
  touchedAt: number;
};

// At most ONE clarification per call: after that the agent must resolve or escalate.
const CLARIFICATION_BUDGET = 1;
const CALL_STATE_TTL_MS = 30 * 60_000;
const callStates = new Map<string, CallState>();

function stateFor(callId: string | null): CallState {
  const key = callId ?? "unknown";
  const now = Date.now();
  for (const [k, v] of callStates) if (now - v.touchedAt > CALL_STATE_TTL_MS) callStates.delete(k);

  const existing = callStates.get(key);
  if (existing) {
    existing.touchedAt = now;
    return existing;
  }
  const fresh: CallState = { clarifications: 0, touchedAt: now };
  callStates.set(key, fresh);
  return fresh;
}

export function forgetCall(callId: string | null | undefined): void {
  if (callId) callStates.delete(callId);
}

// ── Instructions ────────────────────────────────────────────────────────────

const sayVerbatim = (answer: string) =>
  [
    "[ANSWER — APPROVED]",
    "Say this to the caller, word for word, then stop:",
    `"${answer}"`,
    "Do not add to it, do not expand on it, do not volunteer related details, and do not explain where it came from.",
    "If they ask anything further, call lookup_knowledge again.",
  ].join("\n");

const sayParaphrased = (answer: string) =>
  [
    "[ANSWER — APPROVED, REWORDING ALLOWED]",
    "Tell the caller this, and only this, in one short natural sentence:",
    `"${answer}"`,
    "You may reword it to fit the conversation. You may not add a single detail that is not already in that sentence.",
  ].join("\n");

const askThis = (question: string) =>
  [
    "[CLARIFY — DO NOT ANSWER YET]",
    "Ask the caller exactly this, then wait for their reply:",
    `"${question}"`,
    "Do not answer the original question, and do not choose between the possibilities yourself.",
    "When they reply, call lookup_knowledge again with what they said.",
  ].join("\n");

const holdFor = (deflection: string | null, notified: boolean) =>
  [
    "[NO APPROVED ANSWER — DO NOT ANSWER]",
    "You have nothing approved to say about this.",
    `Say something close to: "${deflection ?? "Let me check on that for you."}"`,
    "Never guess, never approximate, and never say what you think the answer probably is.",
    notified
      ? "The team has been alerted and their answer may come through while you are still on the line — keep the caller comfortable rather than rushing to end the call. If they would rather leave a message, take it as normal."
      : "Do not offer to find out. If the caller wants to leave a message, take it as normal.",
  ].join("\n");

const UNAVAILABLE = [
  "[LOOKUP UNAVAILABLE — DO NOT ANSWER]",
  "The knowledge base could not be reached, so nothing is approved for you to say.",
  'Say something close to: "I want to make sure I get that exactly right — let me have someone follow up with you on it."',
  "Take a message as normal. Do not attempt to answer from your own knowledge.",
].join("\n");

const NO_QUESTION = [
  "[NO QUESTION SUPPLIED]",
  "Ask the caller what they would like to know, then call lookup_knowledge again with their own words.",
].join("\n");

// ── Tools ───────────────────────────────────────────────────────────────────

async function lookupKnowledge(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const question = String(args?.question ?? "").trim();
  if (!question) return NO_QUESTION;

  const started = Date.now();
  const state = stateFor(ctx.callId);
  const mayClarify = state.clarifications < CLARIFICATION_BUDGET;

  const { decision } = await decide(question, {
    // The caller's number is the contact identity: it is what a contact-scoped entry
    // is keyed to on a phone product.
    contactId: ctx.callerNumber,
    mayClarify,
  });

  const log = (
    outcome: "answer" | "clarify" | "escalate",
    entryId: string | null,
    matchType: Parameters<typeof logUsage>[0]["match_type"],
    confidence: number | null,
    gate: Parameters<typeof logUsage>[0]["gate_failed"],
    spoken: boolean,
  ) =>
    logUsage({
      vapi_call_id: ctx.callId,
      query: question,
      normalized_key: gapKey(question),
      entry_id: entryId,
      match_type: matchType,
      confidence,
      outcome,
      gate_failed: gate,
      spoken,
      latency_ms: Date.now() - started,
    });

  if (decision.action === "answer") {
    // A clarification was outstanding and it resolved to one of the entries we offered.
    // The caller's original wording is now proven — by the caller — to mean this entry.
    if (state.pending && state.pending.optionIds.includes(decision.entry.id)) {
      learnAlias(decision.entry.id, state.pending.originalQuestion);
    }
    state.pending = undefined;

    log("answer", decision.entry.id, decision.entry.match_type, decision.confidence, null, true);

    if (decision.stale) {
      console.log(
        `⏳ [kb-stale] answered from "${decision.entry.canonical_question}" past its review date — needs a "still true?" from the owner`,
      );
    }
    if (decision.confirmBack) {
      console.log(`📨 [kb-confirm-back] told the caller "${decision.entry.answer_spoken}" — owner should be told it was said`);
    }

    return decision.entry.disclosure === "paraphrase"
      ? sayParaphrased(decision.entry.answer_spoken!)
      : sayVerbatim(decision.entry.answer_spoken!);
  }

  if (decision.action === "clarify") {
    state.clarifications += 1;
    state.pending = { originalQuestion: question, optionIds: decision.options.map((o) => o.id) };
    log("clarify", decision.options[0]?.id ?? null, decision.options[0]?.match_type ?? null, decision.options[0]?.score ?? null, null, false);
    return askThis(decision.ask);
  }

  // Escalate. Nothing below blocks: the row is written and the wearer alerted on a
  // background promise so this returns in single-digit milliseconds.
  state.pending = undefined;
  if (decision.reason === "no_match") recordGap(question);

  if (decision.notifyOwner) {
    raiseEscalation({
      vapiCallId: ctx.callId,
      callerNumber: ctx.callerNumber,
      question,
      reason: decision.reason,
      contextForWearer: decision.contextForWearer,
      suggested: decision.suggested,
      suggestedEntryId: decision.suggestedEntryId,
    });
  }

  log("escalate", null, null, null, decision.reason === "no_match" ? "no_match" : decision.reason, false);
  return holdFor(decision.deflection, decision.notifyOwner);
}

function escalateToOwner(args: Record<string, unknown>, ctx: ToolContext): string {
  const question = String(args?.question ?? "").trim() || "(the caller's request was not captured)";
  raiseEscalation({
    vapiCallId: ctx.callId,
    callerNumber: ctx.callerNumber,
    question,
    reason: "agent_requested",
    contextForWearer: null,
    suggested: null,
    suggestedEntryId: null,
  });
  logUsage({
    vapi_call_id: ctx.callId,
    query: question,
    normalized_key: gapKey(question),
    entry_id: null,
    match_type: null,
    confidence: null,
    outcome: "escalate",
    gate_failed: null,
    spoken: false,
    latency_ms: 0,
  });
  return holdFor("Let me get someone to help with that — one moment.", true);
}

// ── Endpoint ────────────────────────────────────────────────────────────────

export async function vapiTools(req: Request, res: Response): Promise<void> {
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

      try {
        if (name === "lookup_knowledge") return { toolCallId: tc.id, result: await lookupKnowledge(args, ctx) };
        if (name === "escalate_to_owner") return { toolCallId: tc.id, result: escalateToOwner(args, ctx) };
        return { toolCallId: tc.id, result: `[UNKNOWN TOOL "${name}"] Do not answer from your own knowledge. Take a message instead.` };
      } catch (err) {
        // A failure here must never become a guess. Fail closed, loudly in the logs.
        console.error(`[kb] tool ${name} failed:`, err instanceof Error ? err.message : err);
        return { toolCallId: tc.id, result: UNAVAILABLE };
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
