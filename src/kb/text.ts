/**
 * Text normalization shared by matching and by gap clustering.
 *
 * `normalize` must stay in lockstep with the `kb_normalize` SQL function — exact alias
 * matching compares a value normalized here against one normalized there, and a drift
 * between the two would silently stop curated aliases from firing.
 */
export function normalize(t: string | null | undefined): string {
  return (t ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "a", "about", "an", "and", "any", "are", "at", "be", "been", "can", "could", "did", "do",
  "does", "for", "from", "get", "got", "guys", "had", "has", "have", "hi", "hello", "how",
  "i", "if", "in", "is", "it", "just", "know", "like", "me", "my", "of", "on", "or", "our",
  "please", "so", "some", "tell", "that", "the", "their", "them", "there", "they", "this",
  "to", "us", "want", "was", "we", "were", "what", "when", "where", "which", "who", "will",
  "with", "would", "you", "your", "wondering", "quick", "question", "calling", "call",
]);

/** Crude, deliberately. "prices" -> "price", "hours" -> "hour". */
function singularize(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("ss")) return word;
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/**
 * Collapses rephrasings of the same unanswered question onto one key so they cluster.
 * "how much do you charge?" and "what are your prices" both reduce to "charg price"-ish
 * neighbourhoods rather than sitting as two separate near-duplicate gaps.
 *
 * Biased loose on purpose. Over-clustering yields one entry covering several phrasings,
 * which is fine. Under-clustering yields near-duplicate entries, and near-duplicates are
 * what later manufacture ambiguity at answer time.
 */
export function gapKey(question: string): string {
  const seen = new Set<string>();
  for (const word of normalize(question).split(" ")) {
    if (!word || STOPWORDS.has(word)) continue;
    seen.add(singularize(word));
  }
  return [...seen].sort().join(" ");
}
