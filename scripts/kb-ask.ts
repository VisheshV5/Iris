/**
 * Ask the knowledge base a question from the terminal and see exactly what the gate did.
 *
 *   npx tsx scripts/kb-ask.ts "how much is a cleaning"
 *   npx tsx scripts/kb-ask.ts --spent "are you open on the weekend"   # clarification budget used
 *   KB_CONTACT=+16513829872 npx tsx scripts/kb-ask.ts "when is my appointment"
 *
 * Every match is explainable — you can point at the exact reason it fired — which is
 * most of why retrieval here is lexical rather than embedding-based.
 */
import "dotenv/config";
import { decide } from "../src/kb/gate.js";

const args = process.argv.slice(2);
const mayClarify = !args.includes("--spent");
const question = args.filter((a) => a !== "--spent").join(" ").trim();

if (!question) {
  console.error('Usage: npx tsx scripts/kb-ask.ts [--spent] "the caller\'s question"');
  process.exit(1);
}

const started = Date.now();
const { decision, candidates } = await decide(question, {
  contactId: process.env.KB_CONTACT ?? null,
  mayClarify,
});
const ms = Date.now() - started;

console.log(`\n❓ "${question}"${mayClarify ? "" : "   (clarification budget already spent)"}`);

console.log(`\n   retrieved ${candidates.length} candidate(s):`);
for (const c of candidates) {
  const floor = c.score >= c.min_confidence ? "≥" : "<";
  console.log(
    `   ${c.score.toFixed(2)} ${floor} ${c.min_confidence.toFixed(2)}  [${c.match_type}]  ${c.canonical_question}` +
      (c.disclosure !== "speak" ? `  ·${c.disclosure}` : "") +
      (c.autonomy !== "auto" ? `  ·${c.autonomy}` : ""),
  );
}

console.log("");
if (decision.action === "answer") {
  console.log(`   ✅ ANSWER  (confidence ${decision.confidence.toFixed(2)}${decision.stale ? ", past its review date" : ""}${decision.confirmBack ? ", owner will be told it was said" : ""})`);
  console.log(`   → "${decision.entry.answer_spoken}"`);
} else if (decision.action === "clarify") {
  console.log("   ❓ CLARIFY");
  console.log(`   → "${decision.ask}"`);
  console.log("      (the caller's reply will be learned as an alias on whichever entry they pick)");
} else {
  console.log(`   🔔 ESCALATE  (gate: ${decision.reason}${decision.notifyOwner ? "" : ", refusal — owner not disturbed"})`);
  console.log(`   → "${decision.deflection}"`);
  if (decision.suggested) console.log(`   draft for the owner: "${decision.suggested}"`);
  if (decision.contextForWearer) console.log(`   wearer-only context (never spoken):\n      ${decision.contextForWearer.replace(/\n/g, "\n      ")}`);
}

console.log(`\n   ${ms}ms\n`);
process.exit(0);
