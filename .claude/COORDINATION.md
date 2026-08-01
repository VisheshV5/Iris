# Iris — two-session coordination

Two Claude Code sessions work on this repo at the same time. This file is the
contract that keeps them from overwriting each other. **Read it before your first
write of a turn; update the Claims table when you take or release work.**

The repo is not under git, so there is no branch or worktree to fall back on:
a clobbered file is simply lost. Path ownership below is the only safety net.

## The two sessions

| Short name | Session ID | Title |
|---|---|---|
| **A** (original) | `local_bd9e17c3-a311-4324-a6f7-d94db3f233da` | Iris AI receptionist hackathon |
| **B** (sibling) | `local_fb77996b-8def-4058-8115-84eb07574d2a` | Sibling agent for Iris AI receptionist |

Talk to each other with the session-management `send_message` tool. Use it to hand
off, to ask for a claim, and to announce a release.

## Default path ownership

| Path | Owner | Notes |
|---|---|---|
| `ios/**` | **A** | Swift companion app, Meta Wearables DAT, XcodeGen spec. A is mid-build here. |
| `sql/**` | **A** | A wrote `002_call_status.sql`; migrations are append-only and ordered. |
| `src/**` | *unassigned* | Express server, Vapi shim, SIP bridge, Supabase client. |
| `scripts/**` | *unassigned* | Vapi provisioning, migrate runner, SIP agent. |
| `README.md` | *unassigned* | Whoever changes behavior updates the matching section only. |
| `.claude/COORDINATION.md` | shared | Append to the Claims table; never rewrite another session's row. |

"Unassigned" means free to claim, not free-for-all — take it in the Claims table
first so the other session sees it.

## Rules

1. **Never edit a path owned by the other session.** If you need a change there,
   message its owner and let them make it.
2. **Claim before you write** anything outside your own zone. Add a row to Claims,
   then start. If a claim is already open on that path, do not touch it.
3. **Release when done** — mark the row `released` — so the other session can pick
   the area up.
4. **Read before you write, always.** Even inside your own zone: the other session
   may have been handed a file. A `Read` immediately before an `Edit` costs nothing.
5. **Never `Write` (full overwrite) a file you did not create** unless you just read
   it in this same turn. Prefer `Edit` for existing files.
6. **Announce structural changes** — renames, deletions, moved directories, schema
   changes — by message *before* doing them, not after.

## Shared resources — single owner at a time, no exceptions

These are not files, so the Claims table cannot protect them. Whoever holds them
must be named here.

| Resource | Why it is dangerous | Holder |
|---|---|---|
| `.env` | Secrets + `IRIS_MODE`. A blind overwrite loses keys that are not recoverable. | — |
| `vapi.state.json` | Remote-object IDs. Overwriting orphans the live trunk/assistant/number. | — |
| `package.json` / `package-lock.json` | Concurrent `npm install` corrupts the lockfile. | — |
| `npm run setup:vapi` | Mutates **remote** Vapi state (trunk, assistant, phone number). | — |
| `npm run migrate` | Mutates the **remote** Supabase database. | — |
| `npm run dev` (port 3333) | Two servers cannot bind the same port. | — |
| `ngrok http 3333` | A second tunnel changes `PUBLIC_URL` and breaks the Vapi webhook. | — |
| The live phone number | One test call at a time, or the transcripts interleave. | — |

Before running any of the commands above, claim it here and message the other
session. After a `setup:vapi` or `migrate`, message the result so the other
session knows the remote state moved.

## KB invariants

Read these before touching `src/kb/**`, `src/tools.ts`, or the knowledge tool definitions
in `scripts/setup-vapi.ts`. Each one is load-bearing, and each one breaks *silently* —
the call still completes, it just says something it shouldn't have.

1. **Never auto-publish an answer. Auto-publish aliases instead.**
   An owner answering one caller's escalation is not the same as approving a fact for
   every future caller — their answer may have been specific to that person's situation.
   Ingested answers must land as `status='proposed'`, never `'approved'`. The DB blocks
   `approved` unless `confirmed_accurate` and `confirmed_shareable` are both non-null;
   **do not satisfy that constraint programmatically** — those two columns mean a human
   answered two questions. Aliases are the safe thing to auto-accept: a wrong alias costs
   one clarifying question, a wrong published answer costs a caller being told something false.

2. **Every tool return is an instruction, not an answer.**
   Return `Say this, as written: "…"`, never the bare string. Handing the model a naked
   answer leaves it to decide whether to use it. New tools should match this shape or the
   model will treat KB results and other results inconsistently.

3. **The restricted-topic check fails closed.**
   If `restrictedTopics()` throws, `decide()` escalates. That `throw` is deliberate — do
   not "improve" it into a fallback that lets the question through. Failing open means
   answering a refund question because the database hiccuped.

4. **`disclosure='context_only'` entries can never have `answer_spoken`.**
   A CHECK constraint enforces it. This is what makes "may reason with, may never say"
   structural rather than a prompt request. Don't relax the constraint to simplify an insert.

5. **Gate order is the design.** Restricted topics are checked *before* retrieval; a
   confidence score never runs before a permission check. A safeguard evaluated after a
   confidence check is one a high score can argue past.

6. **Keep `lookup_knowledge` free of a `request-start` message.** It returns in ~100ms, so
   a "let me check that" filler adds a spoken turn and makes Iris sound slower. The
   `request-response-delayed` at 1200ms is the intended safety net.

## Claims

Newest last. Status is `open` or `released`.

| Session | Path or resource | Status | What for |
|---|---|---|---|
| A | `ios/**` | open | Building the SwiftUI companion app + glasses integration |
| B | `src/kb/**`, `src/tools.ts` | released | Gated knowledge base behind Vapi custom tools. Handed to A for ROADMAP phases 1–5. See **KB invariants** below before editing. |
| B | `scripts/setup-vapi.ts`, `scripts/migrate.ts`, `scripts/seed-kb.ts`, `scripts/kb-ask.ts` | released | KB provisioning, seeding, and the terminal test harness |
| A | `src/**`, `scripts/setup-vapi.ts`, migrate, setup:vapi, :3333 | open | ROADMAP phases 1–5 (calendar/outbound tools, booking prompt) |
| B | `src/server.ts` | released | Added the `/vapi/tools` and `/kb/escalations/:id/answer` routes plus boot hooks. A owns it again — A's `caller_number` metadata fix is intact. |
| B | `sql/003_knowledge.sql` | released | Applied. New file only; `001`/`002` and the `calls` table untouched. |
| B | `npm run migrate` | released | Ran once at Vishesh's direct instruction. Also fixed `migrate.ts`, which reported SQL errors as connection failures. |
| B | `npm run setup:vapi` | released | Ran once. Assistant `7dfc3bf5` now carries `lookup_knowledge` + `escalate_to_owner`. |
| B | `npm run dev` (port 3333) | **open** | Restarted at 14:1x to mount the new routes — the previous process was running pre-KB code. Tell me before restarting so we don't fight over the port. |
