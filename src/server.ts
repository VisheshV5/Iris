import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { env } from "./env.js";
import { chatCompletions } from "./shim.js";
import { insertCall, markCallRinging } from "./supabase.js";
import { handleTelephonySocket, claimCall, wasClaimed } from "./bridge.js";
import { supabase, getLatestProfile } from "./supabase.js";
import { placeOutboundCall } from "./outbound.js";
import { forgetCall, vapiTools } from "./tools.js";
import { vapiCalendarTools } from "./tools-calendar.js";
import { warmCaches } from "./kb/store.js";
import { deliverAnswer, watchForOwnerAnswers, endHoldsForCall } from "./kb/escalate.js";
import { irisCommand } from "./command.js";

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false })); // Telnyx TeXML posts form-encoded

// A1 voice webhook. Protocol is undocumented; log everything. If A1 expects a
// TwiML-style answer telling it where to stream media, this response provides it.
app.all("/voice", (req, res) => {
  console.log(`[voice] ${req.method} body=${JSON.stringify(req.body ?? null)?.slice(0, 1000)}`);
  const wsUrl = `${env.publicUrl.replace(/^https/, "wss")}/voice-ws`;
  // bidirectionalMode is required — without it the Stream is listen-only and
  // audio we send back (Iris's voice) is silently discarded.
  // The <Redirect> fires when the stream socket closes (Iris hung up OR we cut it
  // for a wearer handoff); /voice/after decides which of those it was.
  res
    .type("text/xml")
    .send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Connect><Stream url="${wsUrl}" bidirectionalMode="rtp" bidirectionalCodec="PCMU" /></Connect><Redirect method="POST">${env.publicUrl}/voice/after</Redirect></Response>`,
    );
});

// Post-stream decision point: if the wearer claimed the call while Iris had it,
// bridge the caller through to the wearer's real phone; otherwise end normally.
app.post("/voice/after", async (req, res) => {
  const callSid = String(req.body?.CallSid ?? "");
  const claimed = callSid ? wasClaimed(callSid) : false;
  const profile = claimed ? await getLatestProfile().catch(() => null) : null;
  let wearerNumber = profile?.phone?.replace(/[^\d+]/g, "") || env.wearerPhone;
  // Founders type bare 10-digit numbers; Telnyx <Dial> needs E.164.
  if (/^\d{10}$/.test(wearerNumber)) wearerNumber = `+1${wearerNumber}`;
  if (/^1\d{10}$/.test(wearerNumber)) wearerNumber = `+${wearerNumber}`;
  console.log(`[voice/after] CallSid=${callSid.slice(0, 24)}… claimed=${claimed} dial=${claimed ? wearerNumber : "-"}`);
  const xml =
    claimed && wearerNumber
      ? `<Response><Dial callerId="${env.a1PhoneNumber}">${wearerNumber}</Dial></Response>`
      : `<Response><Hangup /></Response>`;
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`);
});

app.get("/health", (_req, res) => res.json({ ok: true, mode: env.irisMode }));

// Vapi custom-llm provider appends /chat/completions to the configured URL.
app.post("/openai/chat/completions", chatCompletions);

// Knowledge-base tool calls. Kept separate from /vapi/webhook because this one has a
// latency budget measured against a caller's patience, not a logging pipeline's.
app.post("/vapi/tools", vapiTools);

// Calendar tools (check_availability / book_meeting). Own route so booking work
// can't destabilize the KB path — and vice versa.
app.post("/vapi/tools-calendar", vapiCalendarTools);

// Manual path for delivering an owner's answer into a live call. The companion app
// doesn't need this — writing `owner_answer` on the row is enough, and the Realtime
// subscription picks it up — but it's the easy way to demo the injection by hand.
app.post("/kb/escalations/:id/answer", async (req, res) => {
  const answer = String(req.body?.answer ?? "").trim();
  if (!answer) return res.status(400).json({ error: "answer is required" });
  res.json({ status: await deliverAnswer(req.params.id, answer) });
});

// Founder command channel ("Hey Iris, set up a meeting with…"). Auth is the founder's
// own Supabase JWT, not the anon key — see src/command.ts.
app.post("/iris/command", irisCommand);

app.post("/vapi/webhook", async (req, res) => {
  const message = req.body?.message;
  res.json({}); // ack immediately; Vapi doesn't need a body for these events

  if (!message) return;
  try {
    if (message.type === "status-update" && message.status === "in-progress") {
      const isOutbound =
        (typeof message.call?.type === "string" && message.call.type.toLowerCase().includes("outbound")) ||
        message.call?.metadata?.direction === "outbound";
      const other = message.call?.customer?.number ?? "unknown";
      const callId = message.call?.id;
      if (isOutbound) {
        // Iris placed this one; the app shows it as a live call she's handling.
        console.log(`📞 [outbound] call ${callId ?? "?"} to ${other} is in progress`);
        if (callId) await markCallRinging(callId, other === "unknown" ? null : other, "outbound");
      } else {
        console.log(`📳 [wearer-notify] Incoming call from ${other} — mode=${env.irisMode}`);
        if (callId) await markCallRinging(callId, other === "unknown" ? null : other, "inbound");
      }
    }

    if (message.type === "end-of-call-report") {
      const sd = message.analysis?.structuredData ?? {};
      const record = {
        vapi_call_id: message.call?.id ?? null,
        // Bridge-originated (websocket transport) calls carry the caller in metadata,
        // not customer — customer only exists on real SIP/PSTN Vapi calls.
        caller_number: message.call?.customer?.number ?? message.call?.metadata?.callerNumber ?? null,
        caller_name: sd.caller_name ?? null,
        callback_number: sd.callback_number ?? null,
        reason: sd.reason ?? null,
        summary: message.analysis?.summary ?? null,
        transcript: message.artifact?.transcript ?? message.transcript ?? null,
        branch: env.irisMode,
        started_at: message.startedAt ?? null,
        ended_at: message.endedAt ?? null,
        raw: message,
      } as const;
      await insertCall(record);
      console.log(
        `✅ [call-logged] ${record.caller_name ?? "unknown caller"} (${record.callback_number ?? record.caller_number ?? "no number"}): ${record.reason ?? "no reason captured"}`,
      );
      forgetCall(message.call?.id); // release the per-call clarification budget
      endHoldsForCall(message.call?.id); // stop hold reassurance timers for a call that no longer exists

      // Outbound counter-proposal → ask the founder (glasses/app) → callback loop.
      const isOutboundEnd =
        (typeof message.call?.type === "string" && message.call.type.toLowerCase().includes("outbound")) ||
        message.call?.metadata?.direction === "outbound";
      if (isOutboundEnd && sd.outcome === "counter_proposed") {
        await raiseCallbackEscalation({
          calleeName: sd.callee_name || "the person",
          calleeNumber: message.call?.customer?.number ?? null,
          counterIso: sd.counter_datetime || null,
          counterText: sd.counter_times_text || "a different time",
          vapiCallId: message.call?.id ?? null,
        });
      } else if (isOutboundEnd && (sd.outcome === "declined" || sd.outcome === "no_agreement" || sd.outcome === "voicemail")) {
        // Nothing to book, but the founder still needs to hear how it went — the
        // app speaks this aloud the moment the row lands.
        await announceOutboundOutcome({
          calleeName: sd.callee_name || "they",
          calleeNumber: message.call?.customer?.number ?? null,
          outcome: sd.outcome,
          detail: sd.reason || "",
          vapiCallId: message.call?.id ?? null,
        });
      }
    }
  } catch (err) {
    console.error("[webhook] failed to process event:", err);
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  console.log(`[ws] upgrade request on ${req.url}`);
  wss.handleUpgrade(req, socket, head, (ws) => handleTelephonySocket(ws));
});

server.listen(env.port, () => {
  console.log(`Iris server on http://localhost:${env.port}  (mode=${env.irisMode})`);
  if (!env.publicUrl) console.log("⚠️  PUBLIC_URL not set yet — start ngrok and update .env before running setup:vapi");
  // Load restricted topics before the first call rather than during it, and start
  // listening for the owner answering an escalation from the companion app.
  void warmCaches();
  watchForOwnerAnswers();
  watchForClaims();
  watchForCallbackApprovals();
});

// ── Outbound counter-proposal → founder approval → automatic callback ────────

function speakIso(iso: string): string {
  try {
    return `${new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso))} Pacific`;
  } catch {
    return iso;
  }
}

async function raiseCallbackEscalation(opts: {
  calleeName: string;
  calleeNumber: string | null;
  counterIso: string | null;
  counterText: string;
  vapiCallId: string | null;
}) {
  if (!opts.calleeNumber) return;
  const when = opts.counterIso ? speakIso(opts.counterIso) : opts.counterText;
  // The [ref:] marker makes the row machine-actionable for the callback watcher
  // while the surrounding text stays readable in the app's "for your eyes" card.
  const { error } = await supabase.from("kb_escalations").insert({
    vapi_call_id: opts.vapiCallId,
    caller_number: opts.calleeNumber,
    question: `${opts.calleeName} can't do the proposed time — they suggested ${when}. Book it and call them back?`,
    reason: "agent_requested",
    context_for_wearer: `Reply yes and Iris will call ${opts.calleeName} back to confirm and book it. [ref:${opts.counterIso ?? ""}|${opts.calleeNumber}|${opts.calleeName}]`,
    suggested_answer: "Yes — book it and call them back.",
  });
  if (error) console.error("[callback] failed to raise founder escalation:", error.message);
  else console.log(`🔁 [callback] asked founder: ${opts.calleeName} suggested ${when}`);
}

/// Outbound call ended with nothing to schedule. Raise a row purely so the
/// companion app speaks the outcome to the founder — no [ref:] marker, so the
/// callback watcher leaves it alone.
async function announceOutboundOutcome(opts: {
  calleeName: string;
  calleeNumber: string | null;
  outcome: string;
  detail: string;
  vapiCallId: string | null;
}) {
  // The model often leaves callee_name null; fall back to the number so the
  // spoken announcement never says "they isn't available".
  const who = opts.calleeName && opts.calleeName !== "they" ? opts.calleeName : opts.calleeNumber || "The person you called";
  const headline =
    opts.outcome === "voicemail"
      ? `${who} didn't pick up — I left a message.`
      : `${who} isn't available at that time${opts.detail ? `. ${opts.detail}` : "."}`;
  const { error } = await supabase.from("kb_escalations").insert({
    vapi_call_id: opts.vapiCallId,
    caller_number: opts.calleeNumber,
    question: headline,
    reason: "agent_requested",
    context_for_wearer: "Outbound call outcome — no action needed unless you want to try another time.",
    suggested_answer: "Thanks.",
  });
  if (error) console.error("[outbound] failed to announce outcome:", error.message);
  else console.log(`📣 [outbound] announced to founder: ${headline}`);
}

const AFFIRMATIVE = /\b(yes|yeah|yep|sure|ok(ay)?|works|sounds good|book it|do it|confirm|go ahead|perfect)\b/i;
const NEGATIVE = /\b(no|nope|don't|dont|can't|cant|won't|wont|doesn't work|reject)\b/i;

// Founder answered a callback escalation (via the app's full-screen alert or
// dictation) → if it reads as a yes, place the confirmation call automatically.
function watchForCallbackApprovals() {
  const handled = new Set<string>();
  setInterval(async () => {
    try {
      const { data, error } = await supabase
        .from("kb_escalations")
        .select("id, owner_answer, context_for_wearer")
        .eq("reason", "agent_requested")
        .eq("status", "answered")
        .not("owner_answer", "is", null)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error || !data) return;
      for (const row of data) {
        if (handled.has(row.id)) continue;
        const ref = String(row.context_for_wearer ?? "").match(/\[ref:([^|]*)\|([^|]*)\|([^\]]*)\]/);
        if (!ref) continue; // ordinary knowledge escalation — not ours
        handled.add(row.id);
        const [, iso, number, callee] = ref;
        const answer = String(row.owner_answer ?? "");
        if (!AFFIRMATIVE.test(answer) || NEGATIVE.test(answer)) {
          console.log(`🔁 [callback] founder declined ("${answer.slice(0, 60)}") — no callback to ${callee}`);
          continue;
        }
        const profile = await getLatestProfile().catch(() => null);
        const founder = profile?.full_name || "the founder";
        const when = iso ? speakIso(iso) : "the time they suggested";
        try {
          const { callId } = await placeOutboundCall({
            toNumber: number,
            calleeName: callee,
            founderName: founder,
            company: profile?.company || "",
            mission: `Call ${callee} back: ${founder} confirmed that ${when} works. Confirm it with them in one sentence, then call book_meeting with datetime_iso "${iso}", caller_name "${callee}", and callback_number "${number}", thank them, and end the call.`,
          });
          console.log(`🔁 [callback] founder approved — calling ${callee} back (${callId})`);
        } catch (err) {
          console.error(`[callback] couldn't place callback to ${callee}:`, err instanceof Error ? err.message : err);
        }
      }
    } catch {
      /* next tick */
    }
  }, 2000);
  console.log("[callback] watching for founder approvals on outbound counter-proposals");
}

// The companion app writes wearer_response='claimed' on the ringing row when the
// wearer taps "I've got it"; this hands the live call off to their real phone.
function watchForClaims() {
  supabase
    .channel("wearer-claims")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "calls" },
      (payload: { new: Record<string, unknown> }) => {
        const row = payload.new;
        if (row.wearer_response === "claimed" && row.status === "ringing" && typeof row.vapi_call_id === "string") {
          void claimCall(row.vapi_call_id).then((ok) => {
            if (!ok) console.log(`[handoff] claim for ${row.vapi_call_id} arrived after the call ended`);
          });
        }
      },
    )
    .subscribe((status, err) => {
      console.log(`[handoff] claims subscription: ${status}${err ? ` — ${err.message}` : ""}`);
    });

  // Belt and braces: Realtime delivery to the server-side client has proven flaky,
  // and a missed claim means the wearer taps "I've got it" into the void. A 1s poll
  // on (ringing + claimed) rows is cheap and cannot miss.
  const handled = new Set<string>();
  setInterval(async () => {
    try {
      const { data, error } = await supabase
        .from("calls")
        .select("vapi_call_id")
        .eq("status", "ringing")
        .eq("wearer_response", "claimed");
      if (error || !data) return;
      for (const row of data) {
        const id = row.vapi_call_id as string;
        if (!id || handled.has(id)) continue;
        handled.add(id);
        void claimCall(id).then((ok) => {
          if (!ok) console.log(`[handoff] claim for ${id} had no active bridge (call already over?)`);
        });
      }
    } catch {
      /* next tick */
    }
  }, 1000);
}
