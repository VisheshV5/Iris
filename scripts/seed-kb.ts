/**
 * Seeds a demo knowledge base for Bright Oak Dental.
 *
 * Idempotent: every row carries a fixed id, so re-running updates in place.
 *
 * Note what is NOT here — the owner did not author these by sitting down and writing
 * them. In the real loop, entries are drafted from harvested evidence and the owner only
 * ever answers "did I get that right?" and "okay to tell other people?". This file is
 * standing in for that loop so there is something to demo against.
 */
import "dotenv/config";
import { supabase } from "../src/supabase.js";

const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

// Checked BEFORE retrieval, and stored in their own table so a good match inside the
// knowledge base can never outvote them.
const restricted = [
  {
    id: "11111111-0000-4000-8000-000000000001",
    label: "Refunds and billing disputes",
    patterns: ["refund", "money back", "reimburse", "overcharged", "dispute the charge", "charged me twice"],
    action: "escalate",
    deflection: "That's something I'd want our billing team to look at directly with you — let me get them on it.",
  },
  {
    id: "11111111-0000-4000-8000-000000000002",
    label: "Price negotiation",
    patterns: ["discount", "cheaper", "price match", "negotiate", "any deal", "lower the price", "waive the fee"],
    action: "escalate",
    deflection: "I'm not able to make a call on pricing myself, but I'll have someone who can get straight back to you.",
  },
  {
    id: "11111111-0000-4000-8000-000000000003",
    label: "Clinical and diagnostic advice",
    patterns: ["is it serious", "should i be worried", "do i need a root canal", "diagnose", "is this normal", "what's wrong with my tooth", "is it infected"],
    action: "escalate",
    deflection: "I really don't want to guess at anything clinical — let me get one of the team to speak with you about it.",
  },
  {
    id: "11111111-0000-4000-8000-000000000004",
    label: "Contracts and guarantees",
    patterns: ["contract", "guarantee", "warranty", "sign an agreement", "in writing", "legally"],
    action: "escalate",
    deflection: "That's one for the team to confirm properly rather than me — I'll make sure they follow up.",
  },
  {
    id: "11111111-0000-4000-8000-000000000005",
    label: "Account security changes",
    patterns: ["change my password", "reset my account", "social security", "my card number", "update my payment details"],
    action: "refuse",
    deflection: "I'm not able to help with account or payment details over the phone, and I wouldn't want to take those down here.",
  },
];

const approved = {
  status: "approved",
  confirmed_accurate: true,
  confirmed_shareable: true,
  approved_by: "Vishesh",
  approved_at: daysAgo(3),
  last_confirmed_at: daysAgo(3),
};

const entries = [
  {
    ...approved,
    id: "22222222-0000-4000-8000-000000000001",
    canonical_question: "What are your opening hours?",
    aliases: ["when are you open", "what time do you open", "what are your hours", "how late are you open", "are you open today"],
    tags: ["hours", "scheduling"],
    category: "hours",
    answer_spoken: "We're open Monday through Friday, eight to five, and Saturdays nine to one.",
    min_confidence: 0.65,
  },
  {
    ...approved,
    id: "22222222-0000-4000-8000-000000000002",
    canonical_question: "Are you open on Sundays?",
    // A near-neighbour of the entry above on purpose: "are you open on the weekend" sits
    // between the two, which is exactly the case the ambiguity gate exists for.
    aliases: ["are you open sunday", "do you work sundays", "open on the weekend"],
    tags: ["hours", "scheduling"],
    category: "hours",
    answer_spoken: "We're closed on Sundays, but we are open Saturday mornings until one.",
    min_confidence: 0.65,
  },
  {
    ...approved,
    id: "22222222-0000-4000-8000-000000000003",
    canonical_question: "Where are you located?",
    aliases: ["what's your address", "where are you", "how do i find you", "where's the office", "do you have parking"],
    tags: ["location"],
    category: "location",
    answer_spoken: "We're at 412 Oak Street, just off Grand Avenue, and there's free parking behind the building.",
    min_confidence: 0.65,
  },
  {
    ...approved,
    id: "22222222-0000-4000-8000-000000000004",
    canonical_question: "Are you accepting new patients?",
    aliases: ["are you taking new patients", "can i become a patient", "do you have openings", "accepting new clients"],
    tags: ["patients", "booking"],
    category: "services",
    answer_spoken: "We are taking new patients right now, and the first opening is usually about two weeks out.",
    min_confidence: 0.7,
    // Availability moves. Volatile facts come back to the owner as a one-tap "still true?"
    // rather than quietly answering forever.
    review_after: inDays(7),
  },
  {
    ...approved,
    id: "22222222-0000-4000-8000-000000000005",
    canonical_question: "How much does a routine cleaning cost?",
    aliases: ["how much is a cleaning", "what do you charge for a cleaning", "cost of a checkup", "price of a cleaning"],
    tags: ["pricing"],
    category: "pricing",
    answer_spoken: "A routine cleaning is a hundred and forty dollars without insurance.",
    // A price quote demands more certainty than opening hours. This is the whole reason
    // the floor is per entry rather than global.
    min_confidence: 0.9,
    review_after: inDays(3),
  },
  {
    ...approved,
    id: "22222222-0000-4000-8000-000000000006",
    canonical_question: "What should I do in a dental emergency?",
    aliases: ["i chipped a tooth", "my tooth is killing me", "dental emergency", "i knocked out a tooth", "emergency appointment"],
    tags: ["emergency"],
    category: "urgent",
    answer_spoken: "Call us right away on this number and we'll fit you in the same day — if it's after hours, the message will reach the on-call dentist.",
    min_confidence: 0.6,
  },
  {
    ...approved,
    id: "22222222-0000-4000-8000-000000000007",
    canonical_question: "Do you take my insurance?",
    aliases: ["do you accept insurance", "are you in network", "which insurance do you take", "do you bill insurance"],
    tags: ["insurance", "pricing"],
    category: "insurance",
    answer_spoken: "We work with most major plans, and we can check your specific coverage before your visit.",
    min_confidence: 0.75,
    // Answerable, but the owner wants to know it was said — specific coverage questions
    // have a way of turning into commitments.
    autonomy: "confirm_back",
  },
  {
    // Owner-private. Material Iris may REASON with but must never say.
    //
    // Not a leak waiting to happen but the opposite: this is precisely the context that
    // rides along to the wearer when something escalates, which is what lets the owner
    // answer in one tap. The database forbids it from having spoken text at all.
    id: "22222222-0000-4000-8000-000000000008",
    canonical_question: "When is Vishesh actually free this week?",
    aliases: ["is vishesh around", "when can the owner talk", "is he available"],
    tags: ["availability", "internal"],
    category: "internal",
    answer_spoken: null,
    answer_text: "Blocked out Tuesday and Thursday mornings for surgery. Prefers callbacks after 4pm. Do not commit him to anything before noon.",
    disclosure: "context_only",
    sensitivity: "internal",
    scope: "organization",
    status: "approved",
    confirmed_accurate: true,
    // The owner said no to "okay to tell other people?" and could not name a specific
    // person it belongs to — so it becomes owner-private rather than narrowly scoped.
    // The safe branch, not the clever one.
    confirmed_shareable: false,
    approved_by: "Vishesh",
    approved_at: daysAgo(1),
    last_confirmed_at: daysAgo(1),
    min_confidence: 0.6,
  },
];

const { error: topicError } = await supabase.from("kb_restricted_topics").upsert(restricted);
if (topicError) {
  console.error("❌ restricted topics:", topicError.message);
  process.exit(1);
}
console.log(`✓ ${restricted.length} restricted topics`);

// A multi-row upsert becomes a single INSERT over the union of every key present, so a
// row that omits a column gets an explicit NULL rather than the column's default. Filling
// each row out to the same shape is what keeps the defaults meaningful.
const ENTRY_DEFAULTS = {
  aliases: [] as string[],
  tags: [] as string[],
  category: null as string | null,
  answer_spoken: null as string | null,
  answer_text: null as string | null,
  scope: "organization",
  contact_id: null as string | null,
  disclosure: "speak",
  autonomy: "auto",
  sensitivity: "public",
  min_confidence: 0.7,
  status: "proposed",
  effective_from: null as string | null,
  effective_until: null as string | null,
  review_after: null as string | null,
  last_confirmed_at: null as string | null,
  source_reference: null as string | null,
  approved_by: null as string | null,
  approved_at: null as string | null,
  confirmed_accurate: null as boolean | null,
  confirmed_shareable: null as boolean | null,
};

const { error: entryError } = await supabase
  .from("kb_entries")
  .upsert(entries.map((e) => ({ ...ENTRY_DEFAULTS, ...e })));
if (entryError) {
  console.error("❌ entries:", entryError.message);
  process.exit(1);
}
console.log(`✓ ${entries.length} knowledge entries (1 of them owner-private)`);
console.log('\nTry it:  npx tsx scripts/kb-ask.ts "how much is a cleaning"');
