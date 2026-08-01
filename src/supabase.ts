import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

export const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: { persistSession: false },
});

export type CallRecord = {
  vapi_call_id: string | null;
  caller_number: string | null;
  caller_name: string | null;
  callback_number: string | null;
  reason: string | null;
  summary: string | null;
  transcript: string | null;
  branch: "busy" | "available";
  started_at: string | null;
  ended_at: string | null;
  raw: unknown;
};

export async function insertCall(record: CallRecord) {
  const { error } = await supabase
    .from("calls")
    .upsert({ ...record, status: "completed" }, { onConflict: "vapi_call_id" });
  if (error) throw new Error(`Supabase insert failed: ${error.message}`);
}

export type FounderProfile = {
  full_name: string | null;
  company: string | null;
  role: string | null;
  about: string | null;
  phone: string | null;
  google_refresh_token: string | null;
};

let profileCache: { value: FounderProfile | null; at: number } = { value: null, at: 0 };

// Single-founder deployment: the claimed number belongs to whoever most recently
// saved their profile in the companion app. Cached briefly — this is read at the
// start of every call and must not add latency.
export async function getLatestProfile(): Promise<FounderProfile | null> {
  if (Date.now() - profileCache.at < 30_000) return profileCache.value;
  const { data, error } = await supabase
    .from("profiles")
    .select("full_name, company, role, about, phone, google_refresh_token")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (!error) profileCache = { value: data?.[0] ?? null, at: Date.now() };
  return profileCache.value;
}

// Written the instant a call is answered, before we know anything else about it —
// this is what the iOS app's Realtime subscription picks up to alert the wearer.
export async function markCallRinging(
  vapiCallId: string,
  callerNumber: string | null,
  direction: "inbound" | "outbound" = "inbound",
  calleeName?: string | null,
) {
  const { error } = await supabase.from("calls").upsert(
    {
      vapi_call_id: vapiCallId,
      caller_number: callerNumber,
      status: "ringing",
      direction,
      // For outbound calls the "caller name" is who Iris is calling — the app
      // labels the live card with it.
      ...(calleeName ? { caller_name: calleeName } : {}),
      started_at: new Date().toISOString(),
    },
    { onConflict: "vapi_call_id" },
  );
  if (error) throw new Error(`Supabase ringing-upsert failed: ${error.message}`);
}
