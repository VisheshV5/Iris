/**
 * Business lookup with no Places API key: fetch live web-search results and have
 * the A1 gateway LLM extract the business's phone number from them.
 *
 * The LLM only ever extracts from fetched text — it is explicitly forbidden from
 * answering from memory, because a hallucinated phone number would get a real
 * phone call. Defense in depth: even a wrong extraction is unreachable unless the
 * number is on the VERIFIED_OUTBOUND_NUMBERS consent allowlist (see outbound.ts).
 */
import { env } from "./env.js";
import { normalizeE164 } from "./outbound.js";

export type BusinessResult = { name: string; phone: string | null; address: string | null };

async function webSearchText(query: string): Promise<string> {
  // DuckDuckGo's HTML endpoint is keyless; we only need enough snippet text for
  // the model to find a phone number.
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": "Mozilla/5.0 (iris-hackathon business lookup)" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`search failed ${res.status}`);
  const html = await res.text();
  // Strip tags/scripts down to readable text, capped to keep the LLM call small.
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .slice(0, 6000);
}

export async function findBusiness(name: string, near?: string): Promise<BusinessResult | { error: string }> {
  const query = `${name}${near ? ` ${near}` : ""} phone number`;
  let searchText: string;
  try {
    searchText = await webSearchText(query);
  } catch (err) {
    return { error: `Web search unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    const res = await fetch(`${env.aiGatewayBaseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.aiGatewayKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.irisModel,
        input: [
          {
            role: "system",
            content:
              "You extract business contact info from web search result text. Use ONLY the provided text — never your own knowledge. If you cannot find a phone number explicitly present in the text for the specific business asked about, return nulls. Respond with STRICT JSON only: {\"name\": string|null, \"phone\": string|null, \"address\": string|null}. phone must be digits as found (any format).",
          },
          {
            role: "user",
            content: `Business: ${name}${near ? ` (near ${near})` : ""}\n\nSearch results text:\n${searchText}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { error: `AI lookup failed ${res.status}` };
    const data: any = await res.json();
    const text: string =
      data.output
        ?.flatMap((item: any) => (item.type === "message" ? item.content ?? [] : []))
        .filter((part: any) => part.type === "output_text")
        .map((part: any) => part.text)
        .join("") ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { error: "AI lookup returned no parseable result." };
    const parsed = JSON.parse(jsonMatch[0]) as { name?: string | null; phone?: string | null; address?: string | null };
    if (!parsed.phone) {
      return { error: `Couldn't find a phone number for "${name}"${near ? ` near ${near}` : ""} in search results.` };
    }
    return {
      name: parsed.name ?? name,
      phone: normalizeE164(parsed.phone),
      address: parsed.address ?? null,
    };
  } catch (err) {
    return { error: `AI lookup error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
