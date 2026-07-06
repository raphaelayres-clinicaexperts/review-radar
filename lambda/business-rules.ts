// Regras de negócio de domínio (financeiro, etc.) injetadas no contexto do review — mesma ideia
// do lambda/review-context.ts, mas em vez de código relacionado trazemos a documentação
// destilada das regras de negócio do domínio que o PR toca (business-rules/<domain>.md).
//
// Registry (business-rules/registry.json, espelhado no S3) mapeia domínio -> chave S3 + padrões
// de path (case-insensitive) usados pra decidir se um arquivo do diff pertence àquele domínio.
//
// Contrato: NUNCA lança. Qualquer falha (S3 fora do ar, registry ausente, domínio sem doc)
// devolve "" e o review segue normalmente, só com warn no log.
// Kill switch: BUSINESS_RULES=off desliga completamente.

import type { PR } from "../src/radar/types.ts";

export const BUSINESS_RULES_HEADER_PREFIX = "### Regras de negócio aplicáveis";
const MAX_TOTAL_BYTES = 10_000;

function bucket(): string {
  return process.env.BUSINESS_RULES_BUCKET || "clinicaexperts-insights-data";
}

function prefix(): string {
  const raw = process.env.BUSINESS_RULES_PREFIX || "insights-portal/business-rules/";
  return raw.endsWith("/") ? raw : `${raw}/`;
}

interface RegistryEntry {
  domain: string;
  s3Key: string;
  pathPatterns: string[];
}

async function fetchS3Object(key: string): Promise<string | null> {
  try {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({});
    const res = await client.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    if (!res.Body) return null;
    return await res.Body.transformToString("utf-8");
  } catch (err) {
    console.warn(`[business-rules] falha ao baixar ${key}:`, String(err).slice(0, 150));
    return null;
  }
}

let registryPromise: Promise<RegistryEntry[]> | null = null;
const docCache = new Map<string, Promise<string | null>>();

async function loadRegistry(): Promise<RegistryEntry[]> {
  if (!registryPromise) {
    registryPromise = (async () => {
      const raw = await fetchS3Object(`${prefix()}registry.json`);
      if (!raw) return [];
      try {
        return JSON.parse(raw) as RegistryEntry[];
      } catch (err) {
        console.warn("[business-rules] registry.json inválido:", String(err).slice(0, 150));
        return [];
      }
    })().catch((err) => {
      console.warn("[business-rules] falha ao carregar registry:", String(err).slice(0, 150));
      registryPromise = null; // permite retry numa próxima invocação
      return [];
    });
  }
  return registryPromise;
}

function loadDoc(entry: RegistryEntry): Promise<string | null> {
  if (!docCache.has(entry.s3Key)) {
    docCache.set(entry.s3Key, fetchS3Object(`${prefix()}${entry.s3Key.replace(/^business-rules\//, "")}`));
  }
  return docCache.get(entry.s3Key)!;
}

function matchesEntry(files: string[], entry: RegistryEntry): boolean {
  const lowerFiles = files.map((f) => f.toLowerCase());
  const lowerPatterns = entry.pathPatterns.map((p) => p.toLowerCase());
  return lowerFiles.some((file) => lowerPatterns.some((pattern) => file.includes(pattern)));
}

function rulesDisabled(): boolean {
  return (process.env.BUSINESS_RULES || "").toLowerCase() === "off";
}

export async function buildBusinessRulesContext(pr: PR): Promise<string> {
  if (rulesDisabled()) return "";
  try {
    const registry = await loadRegistry();
    if (!registry.length) return "";

    const filenames = pr.files.map((f) => f.filename);
    const matched = registry.filter((entry) => matchesEntry(filenames, entry));
    if (!matched.length) return "";

    const domains: string[] = [];
    const parts: string[] = [];
    let budget = MAX_TOTAL_BYTES;

    for (const entry of matched) {
      if (budget <= 0) break;
      const doc = await loadDoc(entry);
      if (!doc) continue;
      const piece = doc.length > budget ? `${doc.slice(0, budget)}\n/* ... */` : doc;
      domains.push(entry.domain);
      parts.push(piece);
      budget -= piece.length;
    }

    if (!parts.length) return "";
    return `${BUSINESS_RULES_HEADER_PREFIX} (${domains.join(", ")})\n${parts.join("\n\n")}`;
  } catch (err) {
    console.warn("[business-rules] falhou:", String(err).slice(0, 150));
    return "";
  }
}

export function resetBusinessRulesCacheForTests(): void {
  registryPromise = null;
  docCache.clear();
}
