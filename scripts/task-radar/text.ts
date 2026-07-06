const STOPWORDS_PT = new Set([
  "a", "o", "as", "os", "de", "do", "da", "dos", "das", "em", "no", "na",
  "nos", "nas", "para", "por", "com", "sem", "e", "ou", "um", "uma", "uns",
  "umas", "que", "se", "ao", "aos", "the", "of", "and", "for", "to", "in",
  "on", "is", "are", "this", "that", "que", "sua", "seu", "suas", "seus",
  "quando", "onde", "como", "mais", "menos", "muito", "pelo", "pela",
  "esse", "essa", "esta", "este", "isso", "isto", "nao", "não", "ja", "já",
]);

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function tokenize(text: string): string[] {
  const normalized = stripDiacritics(text.toLowerCase());
  const raw = normalized.match(/[a-z0-9]+/g) ?? [];
  return raw.filter((token) => token.length > 2 && !STOPWORDS_PT.has(token));
}

export function jaccardSimilarity(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;
  const unionSize = new Set([...setA, ...setB]).size;
  return unionSize === 0 ? 0 : intersection / unionSize;
}

export function overlapCount(tokensA: string[], tokensB: string[]): number {
  const setB = new Set(tokensB);
  let count = 0;
  for (const token of new Set(tokensA)) if (setB.has(token)) count++;
  return count;
}
