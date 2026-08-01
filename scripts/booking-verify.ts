/**
 * End-to-end proof of the calendar tool path Iris actually uses on calls:
 *  1. plant a real "blocker" event tomorrow 2-2:30pm
 *  2. check_availability for that exact slot  -> must report busy + alternatives
 *  3. check_availability for tomorrow 5pm    -> must report free
 *  4. book_meeting tomorrow 5pm via the HTTP tool endpoint -> must create a real event
 *  5. verify the booked event exists on Google, then delete both test events
 */
import { createEvent, deleteEvent, freeBusy, FOUNDER_TZ } from "../src/google.js";

const BASE = "http://localhost:3333/vapi/tools-calendar";

function tomorrowAt(hour: number): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: FOUNDER_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const [y, m, d] = fmt.format(new Date(now.getTime() + 24 * 3600_000)).split("-").map(Number);
  // Pacific offset for the demo window (PDT)
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00-07:00`;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: { type: "tool-calls", toolCallList: [{ id: "verify-1", function: { name, arguments: args } }] },
    }),
  });
  const data = (await res.json()) as { results: Array<{ result: string }> };
  return JSON.parse(data.results[0].result);
}

const blockerIso = tomorrowAt(14);
const freeIso = tomorrowAt(17);

console.log("1) Planting blocker event at", blockerIso);
const blocker = await createEvent({
  title: "[iris-verify] blocker",
  startIso: blockerIso,
  endIso: new Date(Date.parse(blockerIso) + 30 * 60_000).toISOString(),
  description: "temporary verification event",
});

try {
  console.log("\n2) check_availability on the blocked slot:");
  const busyCheck = await callTool("check_availability", { datetime_iso: blockerIso, duration_min: 30 });
  console.log("   free =", busyCheck.free, "| alternatives =", busyCheck.alternatives?.length ?? 0);
  if (busyCheck.free !== false) throw new Error("FAIL: blocked slot reported as free — busy detection broken");
  console.log("   ✓ correctly detected the conflict");

  console.log("\n3) check_availability on an open slot:");
  const freeCheck = await callTool("check_availability", { datetime_iso: freeIso, duration_min: 30 });
  console.log("   free =", freeCheck.free);
  if (freeCheck.free !== true) throw new Error("FAIL: open slot reported busy");
  console.log("   ✓ correctly reported open");

  console.log("\n4) book_meeting through the tool endpoint:");
  const booked = await callTool("book_meeting", {
    datetime_iso: freeIso,
    duration_min: 30,
    title: "[iris-verify] booked by tool",
    caller_name: "Verification Bot",
    callback_number: "+15550000000",
  });
  if (!booked.booked || !booked.event_id) throw new Error(`FAIL: booking did not succeed: ${JSON.stringify(booked)}`);
  console.log("   ✓ booked, event id", booked.event_id);

  console.log("\n5) confirming the event really exists on Google...");
  const busyAfter = await freeBusy(freeIso, new Date(Date.parse(freeIso) + 30 * 60_000).toISOString());
  if (!busyAfter.length) throw new Error("FAIL: booked slot still reads free on Google");
  console.log("   ✓ Google now shows that slot busy — the event is real");

  await deleteEvent(booked.event_id);
  console.log("   ✓ cleaned up booked event");
  console.log("\n✅ FULL TOOL PATH VERIFIED: reads real schedule, detects conflicts, creates real events.");
} finally {
  await deleteEvent(blocker.id);
  console.log("✓ cleaned up blocker event");
}
