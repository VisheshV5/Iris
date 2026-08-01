/**
 * Phase 1 acceptance check: prints tomorrow's busy blocks on the founder's primary
 * calendar, then creates and immediately deletes a test event. Read-mostly and
 * self-cleaning — safe to run against the founder's real calendar.
 *
 *   npx tsx scripts/calendar-smoke.ts
 */
import { env } from "../src/env.js";
import { getLatestProfile } from "../src/supabase.js";
import { freeBusy, createEvent, deleteEvent, FOUNDER_TZ } from "../src/google.js";

if (!env.googleClientId || !env.googleClientSecret) {
  console.error(
    "GOOGLE_CLIENT_ID and/or GOOGLE_CLIENT_SECRET are not set in .env.\n" +
      "Use the same OAuth client values as the Google provider in the Supabase dashboard\n" +
      "(Authentication → Providers → Google).",
  );
  process.exit(1);
}

const profile = await getLatestProfile();
if (!profile?.google_refresh_token) {
  console.error(
    "No google_refresh_token on the latest founder profile.\n" +
      "Connect Google Calendar in the companion app — the app must save\n" +
      "session.provider_refresh_token to profiles.google_refresh_token right after the\n" +
      "OAuth redirect (it is only exposed in that first session). Also make sure\n" +
      "sql/005_calendar.sql has been applied (npm run migrate).",
  );
  process.exit(1);
}

// Tomorrow, midnight to midnight, in the founder's timezone.
function founderDayRange(d: Date): { startIso: string; endIso: string; label: string } {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: FOUNDER_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const offset =
    new Intl.DateTimeFormat("en-US", { timeZone: FOUNDER_TZ, timeZoneName: "longOffset" })
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName")
      ?.value.replace("GMT", "") || "Z";
  const start = new Date(`${day}T00:00:00${offset}`);
  return { startIso: start.toISOString(), endIso: new Date(start.getTime() + 24 * 3600_000).toISOString(), label: day };
}

const speak = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: FOUNDER_TZ, hour: "numeric", minute: "2-digit" }).format(new Date(iso));

try {
  const tomorrow = founderDayRange(new Date(Date.now() + 24 * 3600_000));
  console.log(`Busy blocks for ${tomorrow.label} (${FOUNDER_TZ}):`);
  const busy = await freeBusy(tomorrow.startIso, tomorrow.endIso);
  if (busy.length === 0) console.log("  (none — completely free)");
  for (const b of busy) console.log(`  ${speak(b.start)} – ${speak(b.end)}`);

  console.log("\nCreating a 30-minute test event tomorrow at 3:00 PM...");
  const start = new Date(Date.parse(tomorrow.startIso) + 15 * 3600_000);
  const event = await createEvent({
    title: "[Iris smoke test] safe to delete",
    startIso: start.toISOString(),
    endIso: new Date(start.getTime() + 30 * 60_000).toISOString(),
    description: "Created by scripts/calendar-smoke.ts — deleted automatically moments later.",
  });
  console.log(`  ✓ created ${event.id}\n    ${event.htmlLink}`);

  await deleteEvent(event.id);
  console.log("  ✓ deleted again");
  console.log("\n✅ Calendar read/write round-trip works.");
  process.exit(0);
} catch (err) {
  console.error("\n❌ Smoke test failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
