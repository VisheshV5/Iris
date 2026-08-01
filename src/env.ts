import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  a1BaseUrl: process.env.A1_BASE_URL ?? "https://hack.a1mobile.com",
  a1TeamKey: required("A1_TEAM_KEY"),
  a1PhoneNumber: required("A1_PHONE_NUMBER"),
  a1SipUsername: required("A1_SIP_USERNAME"),
  a1SipPassword: required("A1_SIP_PASSWORD"),

  aiGatewayBaseUrl: required("AI_GATEWAY_BASE_URL"),
  aiGatewayKey: required("AI_GATEWAY_KEY"),
  irisModel: process.env.IRIS_MODEL ?? "openai.gpt-5.6-sol",

  vapiApiKey: process.env.VAPI_API_KEY ?? "",

  // Same OAuth client as configured in the Supabase dashboard's Google provider —
  // the server needs it to refresh calendar access tokens from the stored refresh token.
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",

  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  // Optional: used as the `apikey` header when verifying founder JWTs against
  // GET /auth/v1/user. Falls back to the service-role key when unset.
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? "",

  // Optional: Google Places (New) Text Search, for resolving "book a table at Nopa"
  // into a phone number. Reservation-by-business-name degrades gracefully without it.

  // A1 hackathon rules allow outbound calls only to OTP-verified numbers. This is the
  // allowlist the server enforces: comma-separated E.164 numbers, e.g.
  // VERIFIED_OUTBOUND_NUMBERS=+15551234567,+15559876543
  // Verify a number first via POST {A1_BASE_URL}/api/verified-numbers + /confirm.
  verifiedOutboundNumbers: (process.env.VERIFIED_OUTBOUND_NUMBERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  irisMode: (process.env.IRIS_MODE ?? "busy") as "busy" | "available",
  // Demo stand-in: all reservation calls dial this line instead of the real venue
  // (hackathon consent rules — see VERIFIED_OUTBOUND_NUMBERS).
  restaurantDemoNumber: process.env.RESTAURANT_DEMO_NUMBER ?? "",
  wearerPhone: process.env.WEARER_PHONE ?? "",

  port: Number(process.env.PORT ?? 3333),
  publicUrl: (process.env.PUBLIC_URL ?? "").replace(/\/$/, ""),
};
