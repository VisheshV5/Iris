# Iris Roadmap — Calendar, Outbound Calls, Hold-and-Ask

How to drive this in a Claude session, one phase at a time (each is independently
demoable; do them in order — later phases reuse earlier plumbing):

> **"Implement Phase 1 of ROADMAP.md"** … through … **"Implement Phase 5 of ROADMAP.md"**

---

## Current state (what everything below builds on)

- Inbound calls: A1 number → TeXML → media bridge → Vapi "Iris"; per-founder
  personalization from `profiles`; messages/transcripts in `calls`; gated KB with
  `lookup_knowledge` / `escalate_to_owner` tools at `POST /vapi/tools`; live-call voice
  injection via Vapi control URL (`{"type":"say"}`); wearer claim → TeXML `<Redirect>` →
  `<Dial>` handoff. iOS app: auth, profile, live call cards, glasses audio announcements.
- Google OAuth works via Supabase (calendar scope requested at connect).

## Hard external constraints (read before promising demos)

1. **A1 rules: calls/SMS only to OTP-verified numbers** or organizer test lines.
   → Every demo contact for outbound calling & SMS must first complete
   `POST /api/verified-numbers` + `/confirm`. Bake this into demo prep, not code.
2. **Google refresh token**: Supabase only exposes `provider_refresh_token` in the
   session *immediately after* the OAuth redirect. It is not stored server-side today.
   Phase 1 must capture it in the app and persist it (encrypted column on `profiles`)
   or calendar access dies when the access token expires (~1h).
3. **No APNs** (free Apple team): "urgent founder alert" = app-open Realtime + glasses
   audio + repeated TTS, not lock-screen push. Demo with app open.
4. Google Cloud project is in **Testing** mode: every Google account used must be a
   listed test user.

---

## Phase 1 — Calendar read/write foundation

**Goal:** server can check the founder's availability and create events.

- **App:** after the Google OAuth callback, read `session.providerRefreshToken` /
  `providerToken` and write to new `profiles.google_refresh_token` (add column via
  `sql/005_calendar.sql`; RLS: owner-only, service-role select).
- **Server:** `src/google.ts` — token refresh (`oauth2.googleapis.com/token`, needs
  `GOOGLE_CLIENT_ID/SECRET` in `.env`, same values as in Supabase dashboard),
  `freeBusy(rangeStart, rangeEnd)` (freebusy.query), `createEvent(title, start, end,
  attendees?, description)` (events.insert on `primary`).
- **Acceptance:** a script (`scripts/calendar-smoke.ts`) prints tomorrow's busy blocks
  and creates+deletes a test event on the founder's real calendar.

## Phase 2 — Inbound booking during calls

**Goal:** caller asks for a meeting/reservation → Iris books a free slot, suggests
alternatives if busy, gracefully defers if nothing fits.

- **Vapi tools** (add to `scripts/setup-vapi.ts`, handlers in `src/tools.ts` or a new
  `src/tools-calendar.ts` route mounted alongside): 
  - `check_availability(datetime_iso, duration_min)` → `{free: bool, alternatives: [iso...]}`
    (alternatives = next 2–3 free slots within founder's working hours, same/next day).
  - `book_meeting(datetime_iso, duration_min, title, caller_name, callback_number)` →
    creates the event (description = caller details + call id), returns confirmation.
- **Prompt** (buildSystemPrompt): a BOOKING section — always `check_availability`
  before promising; offer at most 2 alternatives; if none work say the founder will
  call back to schedule, and capture it as a normal message. Never reveal *why* a slot
  is busy or what else is on the calendar (privacy: free/busy only).
- **SMS confirmation:** after `book_meeting`, `POST /api/sms` (A1) — **to the founder's
  verified number always**; to the caller **only if** their number is in A1's verified
  list (check → skip silently otherwise; log it). Message: "Iris booked: {title},
  {when}, with {caller_name} ({number})".
- **Acceptance:** live call books a real slot visible in Google Calendar; second call
  asking for the same slot gets offered alternatives; founder receives SMS.

## Phase 3 — Hold-and-ask (confusion → founder via glasses → resume caller)

**Goal:** when Iris is confused twice in a row (or the gate can't answer), she puts the
caller on hold, asks the founder through the glasses, and resumes with the answer.

Builds directly on the existing `kb_escalations` machinery (row → app Realtime → founder
writes `owner_answer` → server injects `{"type":"say"}` into the live call). What's new:

- **Prompt:** track confusion (two consecutive failed understandings, or uncertainty
  about anything factual) → call `escalate_to_owner` with a crisp question + say a hold
  line ("Let me check on that for you — one moment please").
- **Server:** while an escalation is pending on a live call, inject periodic reassurance
  every ~20s ("Thanks for holding, just a moment more"), timeout after ~75s → Iris takes
  a message instead. (Timer keyed by call id in `src/kb/escalate.ts`.)
- **App (urgent founder flow):** full-screen alert card for pending escalations
  (subscribe to `kb_escalations`): the question, `suggested_answer` (one-tap approve),
  `context_for_wearer`, and a freeform reply box with the keyboard's dictation mic —
  that *is* the "founder responds by voice" path (glasses mic → iOS dictation). Glasses:
  urgent audio announcement ("Iris needs you: {question}") + repeat once at 30s.
- **KB learning:** when `owner_answer` is delivered, upsert it into `kb_entries` as an
  approved entry (reuse teammate's ingest design) so the same question never escalates twice.
- **Acceptance:** live call, caller asks something off-book twice → hold line → founder's
  phone+glasses alert → founder dictates reply → Iris speaks it to the caller within ~5s
  → row appears in `kb_entries`; next call gets it answered directly.

## Phase 4 — Founder-initiated outbound calls ("Hey Iris, set up a meeting with…")

**Goal:** founder speaks/types a natural-language instruction; Iris calls the contact
and negotiates a meeting, then books it.

- **Founder command channel (app):** mic button on Home ("Ask Iris") → iOS dictation →
  `POST /iris/command` with the raw text (auth: user JWT). *Not* hardcoded parsing —
  the server passes the text to the LLM with a tool schema
  `{intent: schedule_meeting|make_reservation|other, contact_name?, business_name?,
  datetime?, duration?, notes?}`.
- **Contacts:** app requests Contacts permission; on command, resolves `contact_name`
  → phone number **on device** and includes it in the request (no bulk contact upload —
  only the matched card). Ambiguous matches → app asks the founder to pick.
- **Outbound call engine (server):** `POST https://api.vapi.ai/call` with
  `phoneNumberId` (existing trunk number) + `customer.number` + a **second assistant**
  ("Iris Outbound") whose prompt is: introduce herself as calling on behalf of
  {founder}/{company}, state the proposed time, negotiate against `check_availability`,
  confirm, `book_meeting`, end with a recap. Confusion → same escalate_to_owner flow
  (founder is already holding the phone that launched it).
- **Result surfacing:** end-of-call report → row in `calls` (type: outbound) → app
  announces "Booked: {contact}, Wednesday 3pm" or "Couldn't reach {contact}, left a
  message"; SMS recap to founder.
- **A1 consent rule:** server refuses outbound to numbers not on the A1 verified list,
  with a clear error the app displays ("verify this number first" + the curl/steps).
- **Acceptance:** "set up a 30-minute meeting with Taeyeon tomorrow at 2" → Taeyeon's
  (verified) phone rings → agrees/moves time → calendar event exists → founder sees
  recap + SMS.

## Phase 5 — Reservations via business lookup + location context

**Goal:** "book me a table for 4 at Nopa on Friday at 7" → Iris finds the restaurant's
number, calls, makes the reservation under the founder's name.

- **Business lookup:** Google Places API (Text Search + Place Details for
  `formatted_phone_number`) — new `GOOGLE_PLACES_API_KEY` in `.env`. Bias results by
  founder location (below). If the founder supplied a number directly, skip lookup.
- **Location:** app requests When-In-Use location once, stores coarse city/lat-lng to
  `profiles.location` (new column, owner-only RLS). Used only to bias Places queries
  and default timezones — state this in the permission rationale string.
- **Reservation persona:** outbound assistant variant: "calling on behalf of
  {founder_name} to book a table for {party_size}…", books, then calendar event +
  SMS confirmation to founder. Restaurant staff are humans — prompt must handle IVRs
  and hold music (give up after 2 min, report back).
- **A1 rule again:** the restaurant's number won't be OTP-verified — for the hackathon
  demo, use an organizer test line or a teammate's verified phone playing the
  restaurant host. Flag on stage as a compliance constraint, not a tech gap.
- **Acceptance:** command with a business name → correct number found → call placed →
  reservation confirmed on calendar + SMS.

---

## Sequencing & risk notes

- 1 → 2 unlock the core value; 3 is the wow-demo (glasses in the loop); 4 → 5 are
  the stretch. Each phase ends with a live-call test before moving on.
- Biggest technical risks: refresh-token capture timing (Phase 1 — do it first),
  and outbound-assistant conversation quality against real humans (Phase 4 —
  budget prompt-tuning time).
- Shared-file coordination: `src/tools.ts` and `scripts/setup-vapi.ts` are the sibling
  session's zone (`.claude/COORDINATION.md`); Phase 2/3 touch them — claim or split
  files first. `kb_entries` ingest (Phase 3) is already offered by the sibling session.
- Nothing here changes the working demo paths; every phase is additive behind new
  tools/routes.
