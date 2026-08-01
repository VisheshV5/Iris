# Iris — AI phone secretary (Stage 1)

Calls to the A1Mobile number **+1 (651) 382-9872** land on a Vapi voice assistant
("Iris") over a BYO SIP trunk. Iris takes a message; the post-call report is written
to Supabase. The LLM behind Iris is the A1 AI gateway, reached through a local
chat-completions→Responses-API shim (Vapi only speaks chat/completions).

```
Caller ──▶ A1 number ──▶ SIP trunk (sip.telnyx.com) ──▶ Vapi "Iris"
                                       ┌──────────────────┴─────────────────┐
                                       │ LLM: POST /openai/chat/completions │──▶ A1 Responses API
                                       │ webhook: POST /vapi/webhook        │──▶ Supabase `calls`
                                       └──── this repo's server (ngrok) ────┘
```

## Run it

```bash
npm run dev                       # server on :3333
ngrok http 3333                   # copy the https URL into .env as PUBLIC_URL
npm run migrate                   # one-time: creates the `calls` table
npm run setup:vapi                # provisions/updates trunk + assistant + number
```

Then **call +1 651 382 9872**. Watch the server logs for the simulated wearer
notification and the call-logged line; the row appears in Supabase `calls`.

## Config

- `.env` — all secrets and the `IRIS_MODE` flag (`busy` | `available`), which stubs
  the "try the wearer first vs. handle directly" branch (real branching is Stage 2).
  The branch taken is stored on each call row.
- `iris.config.json` — persona, greeting, wearer/org name: the industry-agnostic
  behavior knobs. Re-run `npm run setup:vapi` after editing either.

## Files

- `src/server.ts` — Express app: shim route + Vapi webhook
- `src/shim.ts` — chat/completions ⇄ Responses API translation (streaming SSE)
- `src/supabase.ts` — service-role client, `calls` upsert
- `scripts/setup-vapi.ts` — idempotent Vapi provisioning (ids in `vapi.state.json`)
- `scripts/migrate.ts` — applies `sql/*.sql` to the Supabase Postgres
- `ios/IrisCompanion/` — the wearer's companion app (see `ios/IrisCompanion/README.md`)

## Stage 2 — iOS companion app + Meta glasses

`ios/IrisCompanion` is a SwiftUI app that:
- Subscribes to Supabase Realtime on `calls` and alerts the wearer (local iOS
  notification + in-app card) the instant a call starts, with **"I've got it"** /
  **"Let Iris handle it"** buttons.
- Relays the same alert to a paired Meta Ray-Ban Display's screen via Meta's
  **Wearables Device Access Toolkit** (DAT) — a real, public SDK Meta opened to
  third-party developers in May 2026 (`facebook/meta-wearables-dat-ios`), not something
  invented for this project.
- Lists completed calls (transcript, summary, reason) pulled from Supabase.

**Known limitation:** tapping "I've got it" records the wearer's intent to Supabase
(`calls.wearer_response`) but does **not** yet reroute the live call to the wearer's
phone — that requires delaying Iris's pickup and conditionally `<Dial>`-forwarding the
TeXML call, which is a separate, larger telephony change not built in this pass. The
`IRIS_MODE` env flag remains what actually drives call-handling behavior for now.

See `ios/IrisCompanion/README.md` for build/pairing instructions.
