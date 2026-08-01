/** Every database access the knowledge base makes. Nothing else talks to Supabase. */
import { supabase } from "../supabase.js";
import { gapKey } from "./text.js";

export type MatchType = "alias_exact" | "question_exact" | "tag_only" | "lexical" | "fuzzy";
export type Disclosure = "speak" | "paraphrase" | "context_only";
export type Autonomy = "auto" | "confirm_back" | "escalate_always";

export type Candidate = {
  id: string;
  canonical_question: string;
  answer_spoken: string | null;
  answer_text: string | null;
  scope: "organization" | "contact";
  contact_id: string | null;
  disclosure: Disclosure;
  autonomy: Autonomy;
  sensitivity: "public" | "internal" | "restricted";
  min_confidence: number;
  review_after: string | null;
  last_confirmed_at: string | null;
  match_type: MatchType;
  score: number;
};

export type RestrictedTopic = {
  id: string;
  label: string;
  patterns: string[];
  action: "escalate" | "refuse";
  deflection: string | null;
};

// Restricted topics are consulted on every question, before retrieval, so they are
// cached rather than fetched per call. A 60s TTL means an operator adding a topic sees
// it take effect within the minute while a live call never pays for the round trip.
let topicCache: { at: number; rows: RestrictedTopic[] } | null = null;
const TOPIC_TTL_MS = 60_000;

export async function restrictedTopics(): Promise<RestrictedTopic[]> {
  if (topicCache && Date.now() - topicCache.at < TOPIC_TTL_MS) return topicCache.rows;

  const { data, error } = await supabase
    .from("kb_restricted_topics")
    .select("id,label,patterns,action,deflection")
    .eq("active", true);

  if (error) {
    // Failing open would mean answering a refund question because the database
    // hiccuped. Serve a stale list if we have one; otherwise throw, which the caller
    // turns into an escalation.
    if (topicCache) return topicCache.rows;
    throw new Error(`restricted topics unavailable: ${error.message}`);
  }

  topicCache = { at: Date.now(), rows: (data ?? []) as RestrictedTopic[] };
  return topicCache.rows;
}

/** Populate the cache at boot so the first caller of the day isn't the one who pays. */
export async function warmCaches(): Promise<void> {
  try {
    const rows = await restrictedTopics();
    console.log(`[kb] ${rows.length} restricted topic(s) loaded`);
  } catch (err) {
    console.error("[kb] could not preload restricted topics:", err instanceof Error ? err.message : err);
  }
}

/**
 * Retrieval plus the eligibility gate, in a single round trip. Entries scoped to a
 * different caller, unapproved, expired, or not yet effective never leave the database.
 */
export async function search(question: string, contactId: string | null, limit = 5): Promise<Candidate[]> {
  const { data, error } = await supabase.rpc("kb_search", {
    p_query: question,
    p_contact_id: contactId,
    p_limit: limit,
  });
  if (error) throw new Error(`kb_search failed: ${error.message}`);
  return (data ?? []) as Candidate[];
}

export type UsageRow = {
  vapi_call_id: string | null;
  query: string;
  normalized_key: string;
  entry_id: string | null;
  match_type: MatchType | null;
  confidence: number | null;
  outcome: "answer" | "clarify" | "escalate";
  gate_failed: "restricted" | "eligibility" | "confidence" | "ambiguity" | "autonomy" | "disclosure" | "no_match" | null;
  spoken: boolean;
  latency_ms: number;
};

// Deliberately not awaited anywhere it is called: a caller is on the line, and logging
// is not worth a millisecond of their silence.
export function logUsage(row: UsageRow): void {
  void supabase
    .from("kb_usage_log")
    .insert(row)
    .then(({ error }) => {
      if (error) console.error("[kb] usage log failed:", error.message);
    });
}

/** Asked once is noise. Asked three times is a missing entry. */
export function recordGap(question: string): void {
  void supabase
    .rpc("kb_record_gap", { p_key: gapKey(question), p_verbatim: question.trim() })
    .then(({ data, error }) => {
      if (error) return console.error("[kb] gap record failed:", error.message);
      if (typeof data === "number" && data >= 3) {
        console.log(`📝 [kb-gap] "${question}" asked ${data}× and still unanswered — ready to draft an entry`);
      }
    });
}

/**
 * The caller said this, we asked which of two things they meant, and they picked one.
 * Their original wording is now a confirmed alias for that entry — proven by observation
 * rather than guessed at by the owner.
 */
export function learnAlias(entryId: string, phrasing: string): void {
  const alias = phrasing.trim();
  if (!alias) return;
  void supabase.rpc("kb_add_alias", { p_entry_id: entryId, p_alias: alias }).then(({ error }) => {
    if (error) console.error("[kb] alias learning failed:", error.message);
    else console.log(`🔤 [kb-alias] "${alias}" now points at entry ${entryId}`);
  });
}
