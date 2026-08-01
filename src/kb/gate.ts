/**
 * The gate. Retrieval proposes candidates; this decides whether any of them is allowed
 * to reach the caller.
 *
 * The ORDER of the checks below is the design, not an implementation detail. A safeguard
 * evaluated after a confidence check is a safeguard that a high score can argue its way
 * past — so restricted topics are consulted before retrieval has even run, and a good
 * match is never treated as permission to speak.
 *
 * Exactly three things can come out of here: ANSWER, CLARIFY, or ESCALATE.
 */
import { restrictedTopics, search, type Candidate } from "./store.js";
import { normalize } from "./text.js";

export type EscalateReason =
  | "restricted" | "eligibility" | "confidence" | "ambiguity" | "autonomy" | "disclosure" | "no_match";

export type Decision =
  | {
      action: "answer";
      entry: Candidate;
      confidence: number;
      /** Past its review date. Still answered — but the owner gets a "still true?" nudge. */
      stale: boolean;
      /** autonomy='confirm_back': the caller hears it, the owner is told it was said. */
      confirmBack: boolean;
    }
  | { action: "clarify"; ask: string; options: Candidate[] }
  | {
      action: "escalate";
      reason: EscalateReason;
      /** What Iris may say while declining. Carries no information by construction. */
      deflection: string | null;
      /** false for a hard refusal — decline without bothering the owner. */
      notifyOwner: boolean;
      /** Owner-private material that helps them answer. Never reaches the caller. */
      contextForWearer: string | null;
      /** Best unusable candidate, pre-filled so the owner taps yes instead of composing. */
      suggested: string | null;
      suggestedEntryId: string | null;
    };

/**
 * How close the top two have to be before the question counts as underspecified.
 * Silently picking the top one is precisely how a confident wrong answer happens.
 */
const AMBIGUITY_MARGIN = 0.08;

/** A near miss is worth one question. Anything vaguer than this goes to the owner. */
const NEAR_MISS_SLACK = 0.15;
const NEAR_MISS_FLOOR = 0.35;

const DEFAULT_DEFLECTION = "I want to make sure I get that exactly right, so let me check with the team.";

/** "What are your opening hours?" -> "your opening hours" */
function topicPhrase(canonical: string): string {
  let s = canonical.trim().replace(/\?+$/, "");
  for (let i = 0; i < 3; i++) {
    s = s.replace(
      /^(what|when|where|which|who|how|do|does|did|can|could|are|is|will|would|much|many|long|often)\b\s*/i,
      "",
    );
  }
  return s.trim() || canonical.trim().replace(/\?+$/, "");
}

function clarifyQuestion(a: Candidate, b: Candidate): string {
  return `Just so I get you the right answer — is this about ${topicPhrase(a.canonical_question)}, or ${topicPhrase(b.canonical_question)}?`;
}

/** context_only entries ride along to the owner: they are what helps them answer. */
function wearerContext(candidates: Candidate[]): string | null {
  const lines = candidates
    .filter((c) => c.disclosure === "context_only")
    .map((c) => `${c.canonical_question} — ${c.answer_text ?? "(no detail recorded)"}`);
  return lines.length ? lines.join("\n") : null;
}

function draftFor(candidates: Candidate[]): { text: string | null; entryId: string | null } {
  const best = candidates.find((c) => c.disclosure !== "context_only" && (c.answer_spoken || c.answer_text));
  return best ? { text: best.answer_spoken ?? best.answer_text, entryId: best.id } : { text: null, entryId: null };
}

export async function decide(
  question: string,
  opts: { contactId: string | null; mayClarify: boolean },
): Promise<{ decision: Decision; candidates: Candidate[] }> {
  const escalate = (
    reason: EscalateReason,
    candidates: Candidate[],
    extra: { deflection?: string | null; notifyOwner?: boolean } = {},
  ): { decision: Decision; candidates: Candidate[] } => {
    const draft = draftFor(candidates);
    return {
      candidates,
      decision: {
        action: "escalate",
        reason,
        deflection: extra.deflection ?? DEFAULT_DEFLECTION,
        notifyOwner: extra.notifyOwner ?? true,
        contextForWearer: wearerContext(candidates),
        suggested: draft.text,
        suggestedEntryId: draft.entryId,
      },
    };
  };

  // ── GATE 1 · RESTRICTED TOPICS ────────────────────────────────────────────
  // Before retrieval is consulted at all. Refunds, pricing negotiation, contractual
  // commitments, professional advice, account security: these escalate no matter how
  // good the match would have been.
  const nq = normalize(question);
  let topics;
  try {
    topics = await restrictedTopics();
  } catch (err) {
    // The list is unavailable, so we cannot prove this question is safe to answer.
    console.error("[kb] restricted-topic check failed, escalating:", err instanceof Error ? err.message : err);
    return escalate("restricted", []);
  }

  const restricted = topics.find((t) => t.patterns.some((p) => p && nq.includes(normalize(p))));
  if (restricted) {
    // Retrieval still runs, but only so the owner gets context — nothing found here can
    // be spoken to the caller.
    const contextOnly = await search(question, opts.contactId, 3).catch(() => [] as Candidate[]);
    return escalate("restricted", contextOnly, {
      deflection: restricted.deflection,
      notifyOwner: restricted.action !== "refuse",
    });
  }

  // ── GATE 2 · ELIGIBILITY ──────────────────────────────────────────────────
  // Applied inside kb_search: unapproved, expired, not-yet-effective, and
  // wrong-contact entries are filtered in the database and never reach this process.
  const candidates = await search(question, opts.contactId, 5);
  if (candidates.length === 0) return escalate("no_match", []);

  // ── GATE 3 · CONFIDENCE FLOOR ─────────────────────────────────────────────
  // Per entry, never global. A single threshold is simultaneously too loose at the top
  // and too strict at the bottom.
  const passing = candidates.filter((c) => c.score >= c.min_confidence);

  if (passing.length === 0) {
    const best = candidates[0];
    // A near miss is worth exactly one question — and the answer to that question is
    // what teaches the base a new alias. Asking reveals nothing, so this is safe.
    if (opts.mayClarify && best.score >= NEAR_MISS_FLOOR && best.score >= best.min_confidence - NEAR_MISS_SLACK) {
      return {
        candidates,
        decision: {
          action: "clarify",
          ask: `Just to make sure I've got you — are you asking about ${topicPhrase(best.canonical_question)}?`,
          options: [best],
        },
      };
    }
    return escalate("confidence", candidates);
  }

  // ── GATE 4 · AMBIGUITY ────────────────────────────────────────────────────
  if (passing.length >= 2 && passing[0].score - passing[1].score < AMBIGUITY_MARGIN) {
    if (!opts.mayClarify) return escalate("ambiguity", candidates);
    return {
      candidates,
      decision: {
        action: "clarify",
        ask: clarifyQuestion(passing[0], passing[1]),
        options: [passing[0], passing[1]],
      },
    };
  }

  // ── GATE 5 · AUTONOMY ─────────────────────────────────────────────────────
  const winner = passing[0];
  if (winner.autonomy === "escalate_always") return escalate("autonomy", candidates);

  // A perfect match on something the owner may reason with but never disclose is still
  // not an answer. The database forbids context_only entries from having spoken text at
  // all, so this is the second of two locks rather than the only one.
  if (winner.disclosure === "context_only" || !winner.answer_spoken) {
    return escalate("disclosure", candidates);
  }

  return {
    candidates,
    decision: {
      action: "answer",
      entry: winner,
      confidence: winner.score,
      stale: Boolean(winner.review_after && new Date(winner.review_after) <= new Date()),
      confirmBack: winner.autonomy === "confirm_back",
    },
  };
}
