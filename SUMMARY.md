# Iris — AI Receptionist · Project Summary

**Concept:** A phone number that answers on behalf of a founder/business. Iris (an AI voice
agent) greets callers as the business, takes messages, answers only approved questions,
and hands off to the founder — who gets notified live on their iPhone and Meta glasses.

## Architecture

```
Caller ─▶ A1 number ─▶ Telnyx TeXML ─▶ our server (/voice) ─▶ media bridge (μ-law⇄PCM)
              +1 937 400 5164                │                        │
                                             │                 Vapi assistant "Iris"
                                             │            (GPT-4.1-mini · ElevenLabs voice)
                                             │                        │
                                   <Redirect>/voice/after      tools: lookup_knowledge,
                                   (handoff decision)          escalate_to_owner
                                             │                        │
                                     Supabase (calls, profiles, kb_*) ─▶ iOS app + glasses
```

- **Telephony:** A1Mobile hackathon number, webhook (TeXML) mode. A custom websocket
  bridge transcodes telephony audio (μ-law 8k) ⇄ Vapi websocket calls (PCM 16k).
- **Voice agent:** Vapi assistant; ElevenLabs "Laura" voice, office ambiance, tuned
  turn-taking; prompt engineered for warm, human-sounding, mumble-tolerant conversation.
- **Storage:** Supabase — `calls` (messages, transcripts, live status), `profiles`
  (founder identity), `kb_*` (gated knowledge base, teammate-built).
- **iOS app (SwiftUI):** magic-link sign-in → founder profile → live call alerts with
  **"I've got it"** handoff, call/message history, Meta Wearables DAT SDK integration.

## What works end-to-end (all verified live)

| Feature | Status |
|---|---|
| Inbound calls answered by Iris, personalized greeting per founder profile | ✅ |
| Message-taking (name, callback number read back digit-by-digit, reason) | ✅ |
| Transcript + structured data + summary written to Supabase per call | ✅ |
| iOS app real-time incoming-call alert (Supabase Realtime) | ✅ |
| **"I've got it" → live call transfers to founder's real phone** (TeXML redirect) | ✅ built, first live test pending |
| Spoken founder summary after each call ("Message from X: …") via glasses audio | ✅ |
| "Taking call" announcement on glasses (audio; Wayfarer Gen 2 has no display) | ✅ |
| Founder onboarding: email sign-in, profile (name/company/role/about/phone) | ✅ |
| Per-call prompt personalization from profile (Vapi template variables) | ✅ |
| Gated knowledge base + owner escalation (sibling session's work) | ✅ |
| Google Calendar connect (OAuth via Supabase) | plumbing done; booking tool next |

## Key decisions & lessons

- **A1's AI gateway (Responses API, no streaming) is too slow for voice** (~2–6s/turn).
  Built a chat-completions⇄Responses shim; kept it behind `IRIS_LLM=a1` flag, but demo
  runs Vapi-native GPT-4.1-mini (~500ms to first word). Flip the flag if judges want
  sponsor-model usage.
- **Vapi BYO SIP trunks can't receive registration-based inbound** — solved by A1's
  webhook mode + our own media bridge (Telnyx `<Stream bidirectionalMode="rtp">`;
  the missing bidirectional attribute was the "Iris is silent" bug).
- **Handoff trick:** TeXML `<Connect><Stream>` falls through to `<Redirect>` when the
  stream closes — so deliberately closing the bridge mid-call lets `/voice/after`
  `<Dial>` the founder's phone: a live human transfer with no Telnyx account access.

## Demo script (2 min)

1. Show the app: profile ("Brief Iris" = your company description), messages inbox.
2. Teammate calls **+1 937 400 5164** → Iris answers as *your* company.
3. Phone + glasses announce "Iris is taking a call"; card appears in-app.
4. Path A: let Iris finish → hear the brief spoken summary; row lands in Messages.
5. Path B: tap **I've got it** → Iris: "one moment, they're actually free" → your
   phone rings, same caller, live.
6. Ask Iris something off-book ("do you do same-day crowns?") → she declines to guess
   and escalates to the owner instead of hallucinating.

## Run it

```bash
npm run dev            # server :3333 (shim, bridge, webhooks, handoff watcher)
ngrok http 3333        # PUBLIC_URL in .env must match; re-run setup:vapi if it changes
npm run migrate        # idempotent schema (001–004)
npm run setup:vapi     # provision/update assistant, trunk, number
```

iOS: `cd ios/IrisCompanion && xcodegen generate`, open in Xcode, run on device
(see ios/IrisCompanion/README.md for signing + glasses pairing).

## Known limitations / next

- Wearer notification requires the app to be open (no APNs push yet — needs paid Apple team).
- Calendar booking tool (`schedule_meeting`) not yet built; requires storing Google's
  refresh token server-side at connect time.
- Founder "about" blurb is paraphrased outside the KB gate (teammate proposed ingesting
  it into approved `kb_entries` — agreed direction, not yet built).
- Single-founder routing (latest saved profile owns the number); multi-tenant needs
  number→profile mapping.
- A1 platform reset team state twice mid-day (number changed); if calls suddenly play
  an error recording, re-run claim + point + setup:vapi.
