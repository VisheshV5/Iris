/**
 * Bridges an inbound A1 media-stream websocket (Twilio/Telnyx-style JSON frames,
 * base64 μ-law 8kHz) to a Vapi websocket-transport call (binary PCM s16le 16kHz).
 *
 * Every inbound frame is logged (first of each type) so we can adapt if A1's
 * protocol differs from the Twilio-style guess.
 */
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { env } from "./env.js";
import { mulawDecode, mulawEncode, upsample2x, downsample2x, int16ToBuffer, bufferToInt16, rms } from "./audio.js";
import { markCallRinging, getLatestProfile } from "./supabase.js";

function assistantId(): string {
  return JSON.parse(readFileSync("vapi.state.json", "utf8")).assistantId;
}

/**
 * Live-call registry for the wearer's "I've got it" handoff.
 *
 * Keyed by TeXML CallSid. When the wearer claims a call, we have Iris hand off
 * verbally, mark the CallSid claimed, and close the media stream; Telnyx then
 * falls through to the <Redirect> in our TeXML, and /voice/after answers with
 * <Dial> to the wearer's real phone.
 */
type ActiveBridge = {
  vapiCallId: string | null;
  controlUrl: string | null;
  endLegs: () => void;
};
const activeBridges = new Map<string, ActiveBridge>();
const claimedCallSids = new Set<string>();

export function wasClaimed(callSid: string): boolean {
  return claimedCallSids.delete(callSid); // one-shot read; the redirect fires exactly once
}

export async function claimCall(vapiCallId: string): Promise<boolean> {
  const entry = [...activeBridges.entries()].find(([, b]) => b.vapiCallId === vapiCallId);
  if (!entry) return false;
  const [callSid, bridge] = entry;
  claimedCallSids.add(callSid);
  console.log(`🤝 [handoff] wearer claimed call ${vapiCallId} — transferring to ${env.wearerPhone}`);
  if (bridge.controlUrl) {
    await fetch(bridge.controlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "say", content: "Oh — one moment please, they're actually free. Connecting you now." }),
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500)); // let the line finish before tearing down
  }
  bridge.endLegs();
  return true;
}

export function handleTelephonySocket(a1: WebSocket) {
  let vapi: WebSocket | null = null;
  let streamSid: string | null = null;
  let callSid: string | null = null;
  let closed = false;
  const seenEvents = new Set<string>();
  const pendingAudio: Buffer[] = [];
  // Diagnostics: frame counts and last audio level per direction.
  const stats = { a1In: 0, toVapi: 0, vapiIn: 0, toA1: 0, a1Rms: 0, vapiRms: 0 };

  const log = (msg: string) => console.log(`[bridge] ${msg}`);
  const statsTimer = setInterval(() => {
    log(
      `stats: a1->vapi ${stats.a1In} frames (rms ${stats.a1Rms}), vapi->a1 ${stats.vapiIn} frames (rms ${stats.vapiRms}), sent ${stats.toVapi}/${stats.toA1}`,
    );
  }, 5000);

  async function startVapiCall(callerNumber?: string) {
    // Personalize this call to whichever founder's profile is live. The assistant's
    // prompt is a template ({{company}}, {{founder_name}}, ...) — these values fill it.
    const profile = await getLatestProfile().catch(() => null);
    const config = JSON.parse(readFileSync("iris.config.json", "utf8"));
    const company = profile?.company || config.orgName || "the office";
    const founderName = profile?.full_name || config.wearerName || "the owner";
    const variableValues = {
      // Without this the model invents a year — it booked a real meeting into 2024.
      today: new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }).format(new Date()),
      company,
      founder_name: founderName,
      founder_role: profile?.role || "the owner",
      company_about: profile?.about || "(no description provided)",
    };

    const res = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.vapiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        assistantId: assistantId(),
        assistantOverrides: {
          variableValues,
          firstMessage: `Hi there, thanks so much for calling ${company}! This is Iris — how can I help you today?`,
        },
        transport: {
          provider: "vapi.websocket",
          audioFormat: { format: "pcm_s16le", container: "raw", sampleRate: 16000 },
        },
        ...(callerNumber ? { metadata: { callerNumber } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Vapi call create failed ${res.status}: ${await res.text()}`);
    const call: any = await res.json();
    const url = call.transport?.websocketCallUrl;
    if (!url) throw new Error(`No websocketCallUrl in Vapi response: ${JSON.stringify(call).slice(0, 300)}`);
    log(`Vapi call ${call.id} created, connecting websocket...`);
    markCallRinging(call.id, callerNumber ?? null).catch((err) => log(`markCallRinging failed: ${err.message}`));
    if (callSid) {
      const bridge = activeBridges.get(callSid);
      if (bridge) {
        bridge.vapiCallId = call.id;
        bridge.controlUrl = call.monitor?.controlUrl ?? null;
      }
    }

    vapi = new WebSocket(url);
    vapi.on("open", () => {
      log("Vapi websocket open — bridging audio");
      for (const buf of pendingAudio.splice(0)) vapi!.send(buf);
    });
    vapi.on("message", (data: Buffer, isBinary: boolean) => {
      try {
        if (!isBinary) {
          const text = data.toString();
          log(`Vapi control: ${text.slice(0, 200)}`);
          return;
        }
        // Vapi audio out (pcm16 @16k) -> μ-law 8k -> A1 media frame
        if (a1.readyState !== WebSocket.OPEN) return;
        const pcm16k = bufferToInt16(data);
        stats.vapiIn++;
        stats.vapiRms = rms(pcm16k);
        const pcm8k = downsample2x(pcm16k);
        const payload = mulawEncode(pcm8k).toString("base64");
        // Telnyx bidirectional stream frame (snake_case, stream_id optional)
        a1.send(JSON.stringify({ event: "media", ...(streamSid ? { stream_id: streamSid } : {}), media: { payload } }));
        stats.toA1++;
      } catch (err) {
        log(`vapi->a1 frame error: ${err instanceof Error ? err.message : err}`);
      }
    });
    vapi.on("close", () => {
      log("Vapi websocket closed — ending telephony leg");
      if (!closed) a1.close();
    });
    vapi.on("error", (err) => log(`Vapi ws error: ${err.message}`));
  }

  a1.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      // Unexpected: raw binary from A1. Log once, treat as μ-law 8k.
      if (!seenEvents.has("__binary")) {
        seenEvents.add("__binary");
        log(`A1 sent binary frame (${data.length} bytes) — treating as raw μ-law`);
      }
      const pcm = int16ToBuffer(upsample2x(mulawDecode(data)));
      if (vapi?.readyState === WebSocket.OPEN) vapi.send(pcm);
      else pendingAudio.push(pcm);
      return;
    }

    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      log(`A1 non-JSON text frame: ${data.toString().slice(0, 200)}`);
      return;
    }
    const event = msg.event ?? msg.type ?? "unknown";
    if (!seenEvents.has(event)) {
      seenEvents.add(event);
      log(`A1 first "${event}" frame: ${JSON.stringify(msg).slice(0, 400)}`);
    }

    switch (event) {
      case "connected":
        break;
      case "start":
      case "streaming_started": {
        streamSid = msg.streamSid ?? msg.stream_id ?? msg.start?.streamSid ?? null;
        callSid = msg.start?.call_control_id ?? null;
        if (callSid) {
          activeBridges.set(callSid, {
            vapiCallId: null,
            controlUrl: null,
            endLegs: () => {
              closed = true;
              vapi?.close();
              a1.close();
            },
          });
        }
        const caller = msg.start?.customParameters?.from ?? msg.start?.from ?? msg.from;
        console.log(`📳 [wearer-notify] Incoming call${caller ? ` from ${caller}` : ""} — mode=${env.irisMode} (simulated push)`);
        startVapiCall(caller).catch((err) => {
          log(`failed to start Vapi call: ${err.message}`);
          a1.close();
        });
        break;
      }
      case "media": {
        const payload = msg.media?.payload ?? msg.payload;
        if (!payload) return;
        try {
          const pcm16 = upsample2x(mulawDecode(Buffer.from(payload, "base64")));
          stats.a1In++;
          stats.a1Rms = rms(pcm16);
          const pcm = int16ToBuffer(pcm16);
          if (vapi?.readyState === WebSocket.OPEN) {
            vapi.send(pcm);
            stats.toVapi++;
          } else pendingAudio.push(pcm);
        } catch (err) {
          log(`a1->vapi frame error: ${err instanceof Error ? err.message : err}`);
        }
        break;
      }
      case "stop":
      case "streaming_stopped":
        log("A1 stream stopped");
        closed = true;
        vapi?.close();
        a1.close();
        break;
    }
  });

  a1.on("close", () => {
    closed = true;
    clearInterval(statsTimer);
    if (callSid) activeBridges.delete(callSid);
    log("A1 websocket closed");
    vapi?.close();
  });
  a1.on("error", (err) => log(`A1 ws error: ${err.message}`));
}
