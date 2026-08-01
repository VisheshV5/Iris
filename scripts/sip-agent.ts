/**
 * Minimal SIP agent for the A1/Telnyx trunk.
 *
 * Registers at sip.telnyx.com with the A1 credentials (so Telnyx has somewhere
 * to deliver inbound calls), and answers every INVITE with a 302 redirect to
 * the Vapi inbound SIP URI ({number}@{credentialId}.sip.vapi.ai). If Telnyx
 * honors the redirect, the entire call (signaling + media) moves to Vapi.
 *
 * Everything is logged so we can see exactly how far the call gets.
 */
// @ts-ignore - no types for the venerable `sip` package
import sip from "sip";
// @ts-ignore
import digest from "sip/digest.js";
import { readFileSync } from "node:fs";
import { env } from "../src/env.js";

const REALM = "sip.telnyx.com";
const EXPIRES = 120;
const credentialId = JSON.parse(readFileSync("vapi.state.json", "utf8")).credentialId as string;
const redirectTarget = `sip:${env.a1PhoneNumber.replace(/^\+/, "")}@${credentialId}.sip.vapi.ai`;

const user = env.a1SipUsername;
const from = `sip:${user}@${REALM}`;

let localPort = 5062;

import { networkInterfaces } from "node:os";
const localIp =
  Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address ?? "127.0.0.1";

sip.start(
  {
    port: localPort,
    logger: {
      send: (m: any) => console.log(`[sip >>] ${m.method ?? m.status} ${m.method ? m.uri : m.reason ?? ""}`),
      recv: (m: any) => console.log(`[sip <<] ${m.method ?? m.status} ${m.method ? m.uri : m.reason ?? ""}`),
    },
  },
  (rq: any) => {
    if (rq.method === "INVITE") {
      const caller = rq.headers.from?.uri ?? "unknown";
      console.log(`\n📞 INVITE received from ${caller}`);
      console.log(`📳 [wearer-notify] Incoming call — redirecting to Vapi: ${redirectTarget}`);
      sip.send(
        sip.makeResponse(rq, 302, "Moved Temporarily", {
          headers: { contact: [{ uri: redirectTarget }] },
        }),
      );
    } else if (rq.method === "OPTIONS") {
      sip.send(sip.makeResponse(rq, 200, "OK"));
    } else if (rq.method === "CANCEL" || rq.method === "BYE" || rq.method === "ACK") {
      if (rq.method !== "ACK") sip.send(sip.makeResponse(rq, 200, "OK"));
    } else {
      sip.send(sip.makeResponse(rq, 405, "Method Not Allowed"));
    }
  },
);

let regCallId = `iris-reg-${Math.random().toString(36).slice(2)}`;
let cseq = 1;

function register() {
  // TCP transport: the INVITE comes back down the same connection we opened,
  // which survives NAT (our Contact IP is a private LAN address).
  const rq: any = {
    method: "REGISTER",
    uri: `sip:${REALM};transport=tcp`,
    headers: {
      to: { uri: from },
      from: { uri: from, params: { tag: Math.random().toString(36).slice(2) } },
      "call-id": regCallId,
      cseq: { method: "REGISTER", seq: cseq++ },
      contact: [
        {
          uri: `sip:${user}@${localIp}:${localPort};transport=tcp`,
          params: { expires: EXPIRES },
        },
      ],
      expires: EXPIRES,
    },
  };

  sip.send(rq, (rs: any) => {
    if (rs.status === 401 || rs.status === 407) {
      const ctx = {};
      digest.signRequest(ctx, rq, rs, { user, password: env.a1SipPassword });
      rq.headers.cseq.seq = cseq++;
      sip.send(rq, (rs2: any) => {
        if (rs2.status === 200) {
          console.log(`✅ REGISTERED at ${REALM} as ${user} (expires ${EXPIRES}s)`);
        } else {
          console.log(`❌ Registration failed after auth: ${rs2.status} ${rs2.reason}`);
        }
      });
    } else if (rs.status === 200) {
      console.log(`✅ REGISTERED (no auth challenge) as ${user}`);
    } else {
      console.log(`❌ Registration failed: ${rs.status} ${rs.reason}`);
    }
  });
}

console.log(`SIP agent starting on UDP :${localPort}; will redirect INVITEs to ${redirectTarget}`);
register();
setInterval(register, (EXPIRES / 2) * 1000);
