/**
 * Does a service-role Realtime subscription actually deliver postgres_changes events?
 *
 * Subscribes exactly the way watchForOwnerAnswers does, then updates a throwaway row and
 * waits. Prints whether the event arrived. Cleans up after itself.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { supabase } from "../src/supabase.js";

const id = randomUUID();
let received = false;

const channel = supabase
  .channel("kb-realtime-check")
  .on("postgres_changes", { event: "UPDATE", schema: "public", table: "kb_escalations" }, (payload) => {
    const row = payload.new as { id: string; owner_answer: string | null };
    if (row.id === id) {
      received = true;
      console.log(`   ← event received, owner_answer = ${JSON.stringify(row.owner_answer)}`);
    }
  });

const subscribed = await new Promise<string>((resolve) => {
  channel.subscribe((status) => {
    console.log(`   channel status: ${status}`);
    if (["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) resolve(status);
  });
  setTimeout(() => resolve("NO_STATUS"), 10_000);
});

if (subscribed !== "SUBSCRIBED") {
  console.error(`\n❌ could not subscribe (${subscribed})`);
  process.exit(1);
}

console.log("   inserting throwaway escalation…");
const { error: insErr } = await supabase.from("kb_escalations").insert({
  id,
  question: "__realtime probe__",
  reason: "no_match",
  status: "pending",
});
if (insErr) {
  console.error(`❌ insert failed: ${insErr.message}`);
  process.exit(1);
}

// Let the subscription settle before the update it is meant to catch.
await new Promise((r) => setTimeout(r, 1000));
console.log("   updating owner_answer…");
const { error: updErr } = await supabase
  .from("kb_escalations")
  .update({ owner_answer: "probe answer", status: "answered" })
  .eq("id", id);
if (updErr) console.error(`   update failed: ${updErr.message}`);

await new Promise((r) => setTimeout(r, 6000));

await supabase.from("kb_escalations").delete().eq("id", id);
await supabase.removeChannel(channel);

console.log(
  received
    ? "\n✅ Realtime DELIVERS to the service-role client — watchForOwnerAnswers is fine as-is."
    : "\n❌ Realtime subscribed but delivered NOTHING — watchForOwnerAnswers needs a poll fallback.",
);
process.exit(received ? 0 : 1);
