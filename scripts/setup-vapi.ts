/**
 * Idempotent Vapi provisioning: SIP trunk credential -> Iris assistant -> BYO phone number.
 * Re-run after changing iris.config.json, IRIS_MODE, or PUBLIC_URL — it PATCHes in place.
 * Created ids are stored in vapi.state.json.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { env } from "../src/env.js";

const VAPI = "https://api.vapi.ai";
const STATE_FILE = "vapi.state.json";

if (!env.vapiApiKey) {
  console.error("VAPI_API_KEY is not set in .env");
  process.exit(1);
}
if (!env.publicUrl) {
  console.error("PUBLIC_URL is not set in .env — start ngrok first (see README)");
  process.exit(1);
}

const config = JSON.parse(readFileSync("iris.config.json", "utf8"));
const state: Record<string, string> = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};

async function vapi(method: string, path: string, body?: unknown) {
  const res = await fetch(`${VAPI}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.vapiApiKey}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vapi ${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function buildSystemPrompt(): string {
  // {{company}}, {{founder_name}}, {{founder_role}}, {{company_about}} are Vapi
  // template variables — filled per call from the founder's profile by the bridge
  // (assistantOverrides.variableValues), so one assistant serves any founder.
  const wearer = "{{founder_name}}";
  const principal = "the team at {{company}}";
  const branchBehavior =
    env.irisMode === "busy"
      ? `No one is available to take the call right now. Do not offer to connect the caller; politely explain that and take a message.`
      : `First, offer to see if someone is available. If the caller says yes, say you'll check, pause briefly, then report that no one can pick up right now and offer to take a message instead. (This hand-off is simulated for now — never claim you actually reached anyone.)`;

  return [
    `You are ${config.assistantName ?? "Iris"}, the AI phone receptionist for {{company}}. You answer on behalf of ${wearer} ({{founder_role}}). Messages you take are passed to ${wearer}, but do not volunteer their name unless the caller asks who handles their request.`,
    config.persona ?? "",
    "",
    "ABOUT {{company}} — safe background you may paraphrase freely:",
    "{{company_about}}",
    "Use this to describe what {{company}} does and to sound like you belong here. It is general background only — specifics still follow the KNOWLEDGE rules below.",
    "",
    "HOW YOU SOUND:",
    "You're genuinely glad to be talking to this caller — warm, upbeat, a little bubbly, like someone who enjoys the front-desk part of the job. Let that energy come through in your word choice, not just tone.",
    "Talk like a real receptionist on a real phone line, not like a script being read aloud. Use contractions (I'm, that's, let's, don't). Keep sentences short and a little uneven in length — real speech isn't uniform.",
    'Open warmly — "Of course!", "Happy to help!", "Oh, absolutely," "Got it!" — and let real enthusiasm show, especially early in the call. Vary it turn to turn so it doesn\'t become a tic.',
    "Vary your phrasing turn to turn; don't reuse the same sentence structure or stock phrase twice in one call.",
    "If you ever need a beat to process, it's fine to say so naturally (\"Let me grab that down\" / \"One sec\") rather than going silent.",
    "Stay warm even while being efficient — brevity doesn't mean sounding curt or flat.",
    "Give your sentences room to breathe: prefer a few short, complete sentences over one long run-on. Use a comma or a dash for a brief natural pause, and a period to fully land a thought before moving to the next.",
    "Do not narrate stage directions or sound effects (no *typing*, no [pause]) — just speak naturally.",
    "You don't need to announce that you're an AI, but if a caller directly and sincerely asks whether you're a bot or a real person, tell them the truth — you're an AI assistant. Never claim to be human.",
    "",
    "CALL HANDLING:",
    branchBehavior,
    "",
    "BOOKING — scheduling a meeting on the calendar:",
    "Today is {{today}}. Every datetime you pass to a tool must be a full ISO 8601 string with the CORRECT year taken from that date — never assume a year, and never reuse a year from your training data.",
    "When a caller wants to schedule a meeting or appointment, get the day, time, and how long they need, then ALWAYS call check_availability before promising, agreeing to, or even hinting that a time might work. Never commit to a slot you have not just checked.",
    "If the requested time is busy, offer at most TWO of the alternatives the tool returned — never more, and never times of your own invention. If neither works for the caller, stop hunting: say someone will call them back to schedule, and take a normal message.",
    "Never reveal why a time is busy, what is on the calendar, or anything about other events or commitments. The calendar is strictly free or busy — nothing more.",
    'Before calling book_meeting, confirm the full date, time, and timezone back to the caller explicitly ("So that\'s Tuesday, August 4th at 2 PM Pacific — shall I lock that in?") and wait for a clear yes.',
    "Book as soon as you have the time and their name — the callback number is NOT required to book. Ask for it afterwards if you don't have it, and if they decline, book anyway and move on.",
    "After book_meeting succeeds, tell the caller the meeting is confirmed and that a confirmation has been sent. If booking fails, never claim it worked — take a message instead.",
    "",
    "KNOWLEDGE — THIS OVERRIDES EVERYTHING ELSE YOU KNOW:",
    `Beyond the ABOUT background above, you do not know anything about {{company}}'s hours, location, services, pricing, availability, policies, staff, or how they work. Not one detail.`,
    "Whenever a caller asks about the business, call lookup_knowledge FIRST, passing their question in their own words. Do this even when the answer seems obvious and even when you feel certain you know it — what sounds reasonable for a business like this one is exactly the guess that gets a caller told something false.",
    "lookup_knowledge returns an instruction, not a suggestion. Follow it exactly:",
    "• [ANSWER — APPROVED] — say the quoted sentence and nothing beyond it.",
    "• [CLARIFY] — ask the quoted question and wait. Do not answer until you have called lookup_knowledge again with their reply.",
    "• [NO APPROVED ANSWER] — do not answer at all. Do not approximate, do not hedge toward an answer, and do not think out loud about what it might be. Deflect as instructed and move on.",
    'Coming up empty is a good outcome, not a failure: "I don\'t have that in front of me, but I\'ll have someone get right back to you" is exactly right. Guessing is the only real failure on this call.',
    "Use escalate_to_owner when the caller needs something no lookup can resolve — a decision, an exception, an approval, or a specific person.",
    "After an escalation, keep the caller comfortable rather than rushing them off the line. An answer from the team may arrive mid-call and be spoken for you; if that happens, carry on naturally from it and never repeat it.",
    "",
    "TAKING A MESSAGE — you must collect all three, one question at a time:",
    "1. The caller's name (confirm spelling if unusual).",
    "2. The best callback number (read it back digit by digit to confirm).",
    "3. The reason for the call, in enough detail to be actionable.",
    "",
    "ENDING THE CALL:",
    `Once you have all three, recap clearly: "Just to confirm — [name], at [number], regarding [reason]." Tell the caller ${principal} will get back to them, thank them, say goodbye, and then end the call.`,
    "",
    "HANDLING UNCLEAR OR WRONG INFORMATION:",
    "You are on a phone line — audio is imperfect. If you didn't fully catch or understand something, never guess and never pretend you understood: briefly say so and ask the caller to repeat just that part.",
    "If a callback number sounds too short, too long, or inconsistent, read back the digits you heard and ask them to correct it.",
    "If something the caller says seems garbled or contradictory, ask one short clarifying question before moving on.",
    "If after two attempts you still can't get a detail, note what you have, say you'll pass it along, and continue gracefully.",
    "",
    "WHEN SOMETHING BREAKS — absolute rule:",
    "If a tool fails, returns an error, or anything technical goes wrong, NEVER read out, quote, or describe the error, and never mention systems, calendars, connections, or anything technical. The caller must never know something broke.",
    `Recover in one of two ways, whichever fits: quietly continue the call without the thing that failed, or say naturally that ${"{{founder_name}}"} will take care of it and get back to them directly — then carry on warmly (take their details if you don't have them).`,
    "",
    "RULES:",
    "Keep every response to one or two short sentences — this is a live phone call.",
    `Never invent information about {{company}}'s schedule, location, services, or pricing — that is what lookup_knowledge is for, and an unanswered question goes to a human rather than to your best guess.`,
    "If the caller refuses to leave some detail, note what you have and move on gracefully.",
    "If the call is a robocall or spam, politely end the call.",
    config.customInstructions ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildOutboundPrompt(): string {
  // {{founder_name}}, {{company}}, {{mission}}, {{callee_name}} are Vapi template
  // variables — filled per call by src/outbound.ts (assistantOverrides.variableValues),
  // so one outbound assistant serves any founder and any mission.
  return [
    `You are ${config.assistantName ?? "Iris"}, a warm, professional AI assistant CALLING OUT on behalf of {{founder_name}} of {{company}}. You placed this call — the person answering was not expecting it, so earn their time quickly.`,
    "",
    "YOUR MISSION — this call exists for exactly one reason:",
    "{{mission}}",
    "Accomplish the mission and nothing else. Do not volunteer other information about {{founder_name}} or {{company}}, and never invent details about either.",
    "",
    "OPENING:",
    'Introduce yourself in one breath: who you are, that you\'re calling for {{founder_name}} at {{company}}, and why. Something like: "Hi! This is Iris — I\'m {{founder_name}}\'s assistant at {{company}}, calling to set something up with you. Do you have a quick moment?"',
    "If they ask whether you're a bot or a real person, tell them the truth — you're an AI assistant calling on {{founder_name}}'s behalf. Never claim to be human.",
    "",
    "PHONE REALITIES:",
    "If an automated menu or IVR answers, listen to the options and say or choose the one that reaches a person who can help (host stand, front desk, reservations, scheduling).",
    "If you're put on hold, wait patiently. If roughly two minutes pass with no human, give up gracefully: leave the mission unresolved and end the call politely.",
    "If voicemail picks up, leave one short message: who you are, who you're calling for, what you wanted to arrange, and that {{founder_name}} will follow up. Then end the call.",
    "",
    "ASKING FOR THEIR TIME — the one and only question that matters:",
    "Today is {{today}}. Any datetime you pass to a tool must use the correct year from that date — never guess a year.",
    "{{founder_name}} already chose the proposed time in your mission. Simply propose it and ask whether it works for THEM. Never check, mention, or worry about any calendar — you are requesting the other person's availability, nothing else.",
    'IF THEY SAY YES: call book_meeting immediately with the agreed ISO time, caller_name "{{callee_name}}", and callback_number "{{callee_number}}" — you already have their number ({{callee_number}}, the one you dialed), so NEVER ask them for it and never escalate to confirm it. Then confirm ("You\'re all set — Saturday, August 1st at 2 PM Pacific. A confirmation is on its way."), thank them warmly, and end the call. If book_meeting fails, never claim it worked — say {{founder_name}} will send the invite shortly, and end politely.',
    'IF THE TIME DOESN\'T WORK: ask what day and time WOULD work for them and get one concrete alternative (day + time). If they simply aren\'t available or don\'t want to meet, accept that gracefully and don\'t push. Either way, do NOT wait, do NOT put them on hold, and do NOT check with anyone: say {{founder_name}} will get back to them shortly to confirm, thank them, and END THE CALL.',
    "Never offer times of your own invention, and never say anything about calendars, systems, or technical issues.",
    "",
    "WHEN CONFUSED:",
    "If the person asks something you cannot answer, needs a decision only {{founder_name}} can make, or the conversation has gone off the rails twice, call escalate_to_owner with a crisp question and keep them comfortable while you wait. Never guess on {{founder_name}}'s behalf.",
    "",
    "HOW YOU SOUND:",
    "Warm, upbeat, and efficient — a real assistant on a real phone line. Use contractions, keep every response to one or two short sentences, and vary your phrasing turn to turn.",
    "Do not narrate stage directions or sound effects — just speak naturally.",
    "",
    "WHEN SOMETHING BREAKS — absolute rule:",
    "If a tool fails, returns an error, or anything technical goes wrong, NEVER read out, quote, or describe the error, and never mention systems, calendars, connections, or anything technical.",
    "Recover naturally: continue without the thing that failed, or say {{founder_name}} will confirm the details directly — then wrap up warmly. Never let a failure show.",
    "",
    "RULES:",
    "This is a live phone call: short sentences, one question at a time.",
    "Respect a clear no: if they decline or ask not to be called, apologize briefly, end the call, and do not argue.",
    config.customInstructions ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

// 1. SIP trunk credential (registers A1's Telnyx credentials so inbound calls reach Vapi)
const credentialBody = {
  provider: "byo-sip-trunk",
  name: "A1Mobile Telnyx trunk",
  gateways: [{ ip: "sip.telnyx.com", inboundEnabled: false }],
  outboundAuthenticationPlan: {
    authUsername: env.a1SipUsername,
    authPassword: env.a1SipPassword,
    sipRegisterPlan: {
      domain: "sip.telnyx.com",
      username: env.a1SipUsername,
      realm: "sip.telnyx.com",
    },
  },
};

// 2. Knowledge tools.
//
// The knowledge base is a function call rather than an upload to Vapi's file-based KB.
// A flat file carries no scope, confidence floor, disclosure level, or effective date,
// and leaves no record of which entry produced an answer — so a contact-scoped or
// unapproved fact becomes retrievable by anyone who phrases a question well. Keeping
// retrieval on our own server makes "this may not be spoken" a structural guarantee
// rather than a request in a prompt.
const toolServer = { url: `${env.publicUrl}/vapi/tools`, timeoutSeconds: 10 };

const knowledgeTools = [
  {
    type: "function",
    async: false,
    function: {
      name: "lookup_knowledge",
      description:
        "Look up what you are permitted to tell this caller about the business. Call this before saying ANYTHING about hours, location, services, availability, pricing, policies, staff, appointments, or process — including when you believe you already know the answer. Returns an instruction stating exactly what you may say.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The caller's question in their own words, as close to verbatim as you can manage. Do not tidy it up, summarise it, or rewrite it into business terminology — their exact phrasing is what makes the lookup accurate.",
          },
        },
        required: ["question"],
      },
    },
    server: toolServer,
    // No request-start filler on purpose: the lookup returns in tens of milliseconds,
    // so announcing it would ADD a spoken turn and make Iris sound slower than she is.
    // The delayed message exists only for the case where something is genuinely wrong.
    messages: [
      { type: "request-response-delayed", content: "Let me just pull that up.", timingMilliseconds: 1200 },
      {
        type: "request-failed",
        content: "I'm having trouble pulling that up right now — let me take a message and have someone follow up.",
      },
    ],
  },
  {
    type: "function",
    async: false,
    function: {
      name: "escalate_to_owner",
      description:
        "Alert the team about something no lookup can resolve: a decision, an exception, an approval, a complaint, or a request for a specific person. Returns immediately — it does not wait for a human. Their reply may be spoken into the call automatically a little later.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "What the caller needs, in enough detail that the team can act on it without hearing the call.",
          },
        },
        required: ["question"],
      },
    },
    server: toolServer,
    messages: [
      { type: "request-failed", content: "Let me take a message and make sure someone gets back to you on that." },
    ],
  },
];

// 2b. Calendar tools. Separate route from the KB tools so each pipeline can evolve
// (and fail) independently; the handlers live in src/tools-calendar.ts.
const calendarToolServer = { url: `${env.publicUrl}/vapi/tools-calendar`, timeoutSeconds: 10 };

const calendarTools = [
  {
    type: "function",
    async: false,
    function: {
      name: "check_availability",
      description:
        "Check whether a requested meeting time is open on the calendar. Call this BEFORE promising, agreeing to, or hinting that any time might work. Returns whether the slot is free, up to two alternative openings, and an instruction stating exactly what you may say. Availability is strictly free or busy — the reason a slot is taken is never available and must never be speculated about.",
      parameters: {
        type: "object",
        properties: {
          datetime_iso: {
            type: "string",
            description:
              "Requested start time as a full ISO 8601 datetime WITH timezone offset, e.g. 2026-08-04T14:00:00-07:00. The business runs on Pacific time — assume it when the caller doesn't say otherwise.",
          },
          duration_min: {
            type: "number",
            description: "Meeting length in minutes. Default 30 if the caller doesn't specify.",
          },
        },
        required: ["datetime_iso"],
      },
    },
    server: calendarToolServer,
    // Unlike lookup_knowledge, this genuinely round-trips to Google — announcing the
    // check covers real latency instead of adding a spoken turn to a fast call.
    messages: [
      { type: "request-start", content: "Let me check the calendar for you." },
      {
        type: "request-failed",
        content: "I'm having trouble reaching the calendar — let me take your details and have someone call you back to schedule.",
      },
    ],
  },
  {
    type: "function",
    async: false,
    function: {
      name: "book_meeting",
      description:
        "Book a meeting on the calendar. Only call this AFTER check_availability said the slot is free AND the caller has explicitly confirmed the full date, time, and timezone. A confirmation is sent automatically once it succeeds.",
      parameters: {
        type: "object",
        properties: {
          datetime_iso: {
            type: "string",
            description: "Confirmed start time as a full ISO 8601 datetime with timezone offset, e.g. 2026-08-04T14:00:00-07:00.",
          },
          duration_min: {
            type: "number",
            description: "Meeting length in minutes. Default 30.",
          },
          title: {
            type: "string",
            description: 'Short event title, e.g. "Call with Dana Ito re: partnership".',
          },
          caller_name: {
            type: "string",
            description: "The caller's name as they gave it.",
          },
          callback_number: {
            type: "string",
            description: "The caller's callback number, read back and confirmed digit by digit.",
          },
        },
        required: ["datetime_iso", "title", "caller_name", "callback_number"],
      },
    },
    server: calendarToolServer,
    messages: [
      { type: "request-start", content: "One moment — putting that on the calendar now." },
      {
        type: "request-failed",
        content: "I couldn't get that onto the calendar just now — let me take your details and have someone confirm the time with you.",
      },
    ],
  },
];

// 3. Assistant
const assistantBody = {
  name: config.assistantName ?? "Iris",
  firstMessage: config.greeting,
  // IRIS_LLM=a1 routes through the shim to the hackathon gateway (no streaming,
  // ~2s/turn); anything else uses Vapi-native OpenAI with streaming (~500ms).
  model:
    process.env.IRIS_LLM === "a1"
      ? {
          provider: "custom-llm",
          url: `${env.publicUrl}/openai`,
          model: env.irisModel,
          messages: [{ role: "system", content: buildSystemPrompt() }],
          tools: [...knowledgeTools, ...calendarTools],
        }
      : {
          provider: "openai",
          model: "gpt-4.1-mini",
          messages: [{ role: "system", content: buildSystemPrompt() }],
          tools: [...knowledgeTools, ...calendarTools],
        },
  voice: config.voice ?? {
    provider: "11labs",
    voiceId: "FGY2WhTYpPnrIDTdsKH5", // "Laura" — ElevenLabs' own tag: "sunny enthusiasm, quirky attitude"
    model: "eleven_multilingual_v2", // richer emotional prosody than the turbo models; latency budget allows it
    stability: 0.28, // low = wide pitch/energy swings instead of a flat monotone read
    similarityBoost: 0.85,
    style: 0.6, // strong push toward the voice's natural expressive character
    useSpeakerBoost: true,
    optimizeStreamingLatency: 0, // max quality — we have latency headroom from the fast LLM
    speed: 0.93, // a touch slower than default reads as unhurried/warm rather than clipped
    // Wider, sentence-level chunks so ElevenLabs synthesizes whole clauses continuously
    // instead of fragmenting on every comma — that fragmentation is what reads as choppy/robotic.
    chunkPlan: {
      enabled: true,
      minCharacters: 80,
      punctuationBoundaries: [".", "!", "?"],
    },
  },
  backgroundSound: "office",
  // Turn-taking timing tuned for natural back-and-forth: don't cut the caller off after
  // one filler word, and don't leave dead air before Iris responds.
  startSpeakingPlan: {
    waitSeconds: 0.3,
    smartEndpointingPlan: { provider: "vapi" },
  },
  stopSpeakingPlan: {
    numWords: 2,
    voiceSeconds: 0.2,
    backoffSeconds: 0.8,
  },
  endCallFunctionEnabled: true,
  server: { url: `${env.publicUrl}/vapi/webhook` },
  serverMessages: ["end-of-call-report", "status-update"],
  analysisPlan: {
    summaryPlan: { enabled: true },
    structuredDataPlan: {
      enabled: true,
      schema: {
        type: "object",
        properties: {
          caller_name: { type: "string", description: "The caller's name as they gave it" },
          callback_number: { type: "string", description: "Callback phone number the caller left" },
          reason: { type: "string", description: "Why the caller called" },
        },
      },
    },
  },
};

// 4. Outbound assistant ("Iris Outbound") — used by POST /iris/command to place
// founder-initiated calls (meetings, reservations). Same calendar tools and the same
// escalate_to_owner flow; the per-call goal arrives as the {{mission}} variable.
// Outbound calls ask for the CALLEE's availability — the founder already chose
// the time, so check_availability is deliberately excluded: nothing to check.
const outboundTools = [
  ...calendarTools.filter((t) => t.function.name !== "check_availability"),
  knowledgeTools.find((t) => t.function.name === "escalate_to_owner")!,
];

const outboundAssistantBody = {
  name: "Iris Outbound",
  firstMessage: `Hi there! This is Iris — I'm calling on behalf of {{founder_name}} at {{company}}. Do you have a quick moment?`,
  model:
    process.env.IRIS_LLM === "a1"
      ? {
          provider: "custom-llm",
          url: `${env.publicUrl}/openai`,
          model: env.irisModel,
          messages: [{ role: "system", content: buildOutboundPrompt() }],
          tools: outboundTools,
        }
      : {
          provider: "openai",
          model: "gpt-4.1-mini",
          messages: [{ role: "system", content: buildOutboundPrompt() }],
          tools: outboundTools,
        },
  voice: assistantBody.voice,
  backgroundSound: "office",
  startSpeakingPlan: assistantBody.startSpeakingPlan,
  stopSpeakingPlan: assistantBody.stopSpeakingPlan,
  endCallFunctionEnabled: true,
  server: { url: `${env.publicUrl}/vapi/webhook` },
  serverMessages: ["end-of-call-report", "status-update"],
  analysisPlan: {
    summaryPlan: { enabled: true },
    structuredDataPlan: {
      enabled: true,
      schema: {
        type: "object",
        properties: {
          outcome: {
            type: "string",
            description:
              "One of: booked (they agreed and it was booked), counter_proposed (their time didn't work and they offered another), declined, voicemail, no_agreement, gave_up",
          },
          agreed_datetime: { type: "string", description: "The agreed time in ISO 8601, if one was agreed" },
          counter_datetime: {
            type: "string",
            description: "The callee's suggested alternative in full ISO 8601 with timezone offset, if they offered one",
          },
          counter_times_text: { type: "string", description: "The callee's alternative time(s) in their own words" },
          callee_name: { type: "string", description: "Who was reached on the call" },
          reason: { type: "string", description: "One-line summary of what happened on the call" },
        },
      },
    },
  },
};

try {
  if (state.credentialId) {
    // Non-fatal: the credential only changes when A1 issues new SIP creds, and
    // Vapi's PATCH /credential endpoint is intermittently flaky.
    try {
      await vapi("PATCH", `/credential/${state.credentialId}`, credentialBody);
      console.log(`✓ SIP trunk credential updated (${state.credentialId})`);
    } catch (err) {
      console.warn(`⚠ credential update failed (continuing): ${err instanceof Error ? err.message.slice(0, 200) : err}`);
    }
  } else {
    const cred = await vapi("POST", "/credential", credentialBody);
    state.credentialId = cred.id;
    console.log(`✓ SIP trunk credential created (${cred.id})`);
  }

  if (state.assistantId) {
    await vapi("PATCH", `/assistant/${state.assistantId}`, assistantBody);
    console.log(`✓ Assistant updated (${state.assistantId})`);
  } else {
    const assistant = await vapi("POST", "/assistant", assistantBody);
    state.assistantId = assistant.id;
    console.log(`✓ Assistant created (${assistant.id})`);
  }

  if (state.outboundAssistantId) {
    await vapi("PATCH", `/assistant/${state.outboundAssistantId}`, outboundAssistantBody);
    console.log(`✓ Outbound assistant updated (${state.outboundAssistantId})`);
  } else {
    const outbound = await vapi("POST", "/assistant", outboundAssistantBody);
    state.outboundAssistantId = outbound.id;
    console.log(`✓ Outbound assistant created (${outbound.id})`);
  }

  const phoneBody = {
    provider: "byo-phone-number",
    name: "Iris A1 number",
    number: env.a1PhoneNumber.replace(/^\+/, ""),
    numberE164CheckEnabled: false,
    credentialId: state.credentialId,
    assistantId: state.assistantId,
  };
  if (state.phoneNumberId) {
    await vapi("PATCH", `/phone-number/${state.phoneNumberId}`, {
      assistantId: state.assistantId,
      credentialId: state.credentialId,
    });
    console.log(`✓ Phone number updated (${state.phoneNumberId})`);
  } else {
    const phone = await vapi("POST", "/phone-number", phoneBody);
    state.phoneNumberId = phone.id;
    console.log(`✓ Phone number attached (${phone.id})`);
  }

  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`\n✅ Vapi is wired up. Call ${env.a1PhoneNumber} to talk to Iris.`);
} catch (err) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.error("\n❌ Setup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
