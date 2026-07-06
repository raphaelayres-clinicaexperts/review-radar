import { directChatCompletion } from "../../lambda/codex-client.ts";
import type { Store } from "../../lambda/store.ts";
import { extractJson } from "./json-extract.ts";
import type {
  Call1Result,
  CandidateModule,
  Difficulty,
  DuplicateFlag,
  ModuleAssessment,
  PipelineUsage,
  SimilarNote,
  SimilarTaskRef,
  TaskAnalysis,
  TaskInput,
} from "./types.ts";

const MAX_OUTPUT_MODULES = 8;

// Permite trocar o modelo usado nas 2 chamadas Codex do pipeline (triagem e estimativa) sem
// mexer no default de produção. Sem a env, `directChatCompletion` cai no resolveCodexModel(undefined)
// de sempre (DEFAULT_CODEX_MODEL).
const TASK_RADAR_MODEL = process.env.TASK_RADAR_MODEL?.trim() || undefined;

const SYSTEM_TRIAGE = [
  "Você é um analista técnico sênior de engenharia de software, especialista no codebase de um",
  "sistema de clínicas médicas em Laravel/PHP. Sua tarefa é analisar uma task do Jira antes de ela",
  "entrar em desenvolvimento, apontando quais módulos do sistema provavelmente serão afetados",
  "e quais arquivos de código vale a pena inspecionar antes de estimar a complexidade.",
  "Responda SEMPRE em português brasileiro e SEMPRE com um único objeto JSON válido,",
  "sem texto fora do JSON e sem blocos de markdown.",
].join(" ");

const SYSTEM_ESTIMATOR = [
  "Você é um analista técnico sênior de engenharia de software revisando uma task de Jira",
  "antes da estimativa de esforço, com acesso a trechos reais de código do repositório.",
  "Seu objetivo é produzir um veredito estruturado de dificuldade, risco, módulos afetados e",
  "possível duplicidade com trabalho já feito. Responda SEMPRE em português brasileiro e",
  "SEMPRE com um único objeto JSON válido, sem texto fora do JSON e sem blocos de markdown.",
].join(" ");

function formatSimilarForPrompt(similar: SimilarTaskRef[]): string {
  if (similar.length === 0) return "(nenhuma task histórica com título similar encontrada)";
  return similar
    .map(
      (s, i) =>
        `${i + 1}. [${s.key ?? "sem-chave"}] PR #${s.pr} — "${s.title}" — módulos tocados: ${
          s.modules.length ? s.modules.join(", ") : "(não identificados)"
        }`
    )
    .join("\n");
}

function taskBlock(task: TaskInput): string {
  return [
    `Chave: ${task.key ?? "(nova task, sem chave ainda)"}`,
    `Tipo: ${task.issueType ?? "desconhecido"}`,
    `Título: ${task.title}`,
    `Descrição:\n${task.description || "(sem descrição)"}`,
  ].join("\n");
}

export interface Call1PromptInput {
  task: TaskInput;
  projectMapMarkdown: string;
  similarTasks: SimilarTaskRef[];
}

export function buildCall1Prompt(input: Call1PromptInput): { system: string; user: string } {
  const user = [
    "## Task a analisar",
    taskBlock(input.task),
    "",
    "## Mapa do projeto (módulos anotados)",
    input.projectMapMarkdown,
    "",
    "## Tasks históricas com título similar (top 15 por overlap de palavras)",
    formatSimilarForPrompt(input.similarTasks),
    "",
    "## O que fazer",
    "1. Aponte SOMENTE os módulos do mapa do projeto (use o campo `path` exatamente como aparece",
    "   no mapa) onde há necessidade REAL de alterar código para esta task — não inclua módulos",
    "   apenas 'possivelmente relacionados', adjacentes ou tangenciais. Liste no máximo 6 módulos,",
    "   ordenados por probabilidade decrescente, com uma razão curta cada.",
    "2. Liste as chaves (`key`) das tasks históricas acima que parecem realmente relacionadas",
    "   ao mesmo assunto/área (não apenas coincidência de palavras).",
    "3. Liste até 6 caminhos de arquivo (paths reais dentro dos módulos apontados) que valeria",
    "   a pena abrir para entender o código antes de estimar a complexidade.",
    "",
    "## Formato de saída — responda APENAS este JSON:",
    "{",
    '  "candidateModules": [{ "path": "app/...", "reason": "..." }],',
    '  "similarTasks": ["CE-1234"],',
    '  "needsCode": ["app/Caminho/Arquivo.php"]',
    "}",
  ].join("\n");

  return { system: SYSTEM_TRIAGE, user };
}

interface RawCall1Response {
  candidateModules?: Array<{ path?: unknown; reason?: unknown }>;
  similarTasks?: unknown[];
  needsCode?: unknown[];
}

export function parseCall1Response(raw: string): Call1Result {
  const parsed = extractJson<RawCall1Response>(raw);

  const candidateModules: CandidateModule[] = (parsed.candidateModules ?? [])
    .filter((m) => typeof m?.path === "string")
    .map((m) => ({
      path: String(m.path),
      reason: typeof m.reason === "string" ? m.reason : "",
    }));

  const similarTasks = (parsed.similarTasks ?? [])
    .filter((k) => typeof k === "string" && k.trim() !== "")
    .map((k) => String(k));

  const needsCode = (parsed.needsCode ?? [])
    .filter((p) => typeof p === "string" && p.trim() !== "")
    .map((p) => String(p))
    .slice(0, 6);

  return { candidateModules, similarTasks, needsCode };
}

export async function runCall1(
  store: Store,
  input: Call1PromptInput
): Promise<{ result: Call1Result; usage: PipelineUsage }> {
  const { system, user } = buildCall1Prompt(input);
  const response = await directChatCompletion(store, { system, user, model: TASK_RADAR_MODEL });
  const result = parseCall1Response(response.content);
  return {
    result,
    usage: { promptTokens: response.promptTokens, completionTokens: response.completionTokens, calls: 1 },
  };
}

export interface ModuleWithSummary {
  path: string;
  reason: string;
  summary: string;
}

export interface Call2PromptInput {
  task: TaskInput;
  candidateModules: ModuleWithSummary[];
  codeSnippets: Array<{ path: string; content: string; truncated: boolean }>;
  similarTasks: SimilarTaskRef[];
}

function formatModulesForPrompt(modules: ModuleWithSummary[]): string {
  if (modules.length === 0) return "(nenhum módulo candidato identificado na etapa anterior)";
  return modules
    .map((m, i) => `${i + 1}. ${m.path} — motivo: ${m.reason || "(sem motivo informado)"}\n   resumo: ${m.summary || "(módulo não encontrado no mapa)"}`)
    .join("\n");
}

function formatSnippetsForPrompt(
  snippets: Array<{ path: string; content: string; truncated: boolean }>
): string {
  if (snippets.length === 0) return "(nenhum trecho de código disponível)";
  return snippets
    .map(
      (s) =>
        `### ${s.path}${s.truncated ? " (truncado em 300 linhas)" : ""}\n\`\`\`\n${s.content}\n\`\`\``
    )
    .join("\n\n");
}

export function buildCall2Prompt(input: Call2PromptInput): { system: string; user: string } {
  const user = [
    "## Task a analisar",
    taskBlock(input.task),
    "",
    "## Módulos candidatos (identificados na etapa anterior, com resumo do mapa do projeto)",
    formatModulesForPrompt(input.candidateModules),
    "",
    "## Trechos de código reais (branch main)",
    formatSnippetsForPrompt(input.codeSnippets),
    "",
    "## Tasks históricas relacionadas",
    formatSimilarForPrompt(input.similarTasks),
    "",
    "## O que fazer",
    "Com base em tudo acima, produza o veredito final da pré-análise desta task.",
    "- difficulty: seu palpite de P (pequena), M (média) ou G (grande) para o tamanho geral do",
    "  esforço. Este é só um palpite secundário — a classificação final é calculada à parte por",
    "  outro processo — então responda com base na sua impressão geral da task, sem tentar",
    "  justificar com número de linhas.",
    "- score: de 1 a 10, 1 = trivial, 10 = extremamente arriscada/complexa.",
    "- rationale: 1 a 2 frases explicando a nota.",
    "- modules: liste todos os módulos com necessidade REAL de alteração de código (não",
    "  infraestrutura tangencial nem módulos apenas 'possivelmente relacionados'), até 8. Ordene",
    "  por confidence decrescente. Prefira ERRAR incluindo um módulo em que há dúvida razoável a",
    "  omitir um módulo que de fato precisa mudar — só descarte confidence muito baixa (<0.3).",
    "- risks: lista curta de riscos técnicos concretos (strings curtas).",
    "- split: se a task for grande e valer a pena quebrar em subtasks, liste-as; senão retorne null.",
    "- similar: para cada task histórica realmente relevante, uma nota curta do porquê.",
    "- duplicateFlag: suspected=true se parecer que esse trabalho já foi feito recentemente, com why.",
    "",
    "## Formato de saída — responda APENAS este JSON:",
    "{",
    '  "difficulty": "P",',
    '  "score": 5,',
    '  "rationale": "...",',
    '  "modules": [{ "path": "app/...", "confidence": 0.8, "what": "..." }],',
    '  "risks": ["..."],',
    '  "split": null,',
    '  "similar": [{ "key": "CE-1234", "pr": 100, "note": "..." }],',
    '  "duplicateFlag": { "suspected": false, "why": "" }',
    "}",
  ].join("\n");

  return { system: SYSTEM_ESTIMATOR, user };
}

interface RawCall2Response {
  estimatedLines?: unknown;
  difficulty?: unknown;
  score?: unknown;
  rationale?: unknown;
  modules?: Array<{ path?: unknown; confidence?: unknown; what?: unknown }>;
  risks?: unknown[];
  split?: unknown;
  similar?: Array<{ key?: unknown; pr?: unknown; note?: unknown }>;
  duplicateFlag?: { suspected?: unknown; why?: unknown };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeDifficulty(raw: unknown): Difficulty {
  const value = String(raw ?? "").trim().toUpperCase();
  if (value === "P" || value === "M" || value === "G") return value;
  return "M";
}

export function parseCall2Response(raw: string): TaskAnalysis {
  const parsed = extractJson<RawCall2Response>(raw);

  const modules: ModuleAssessment[] = (parsed.modules ?? [])
    .filter((m) => typeof m?.path === "string")
    .map((m) => ({
      path: String(m.path),
      confidence: clamp(Number(m.confidence) || 0, 0, 1),
      what: typeof m.what === "string" ? m.what : "",
    }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_OUTPUT_MODULES);

  const risks = (parsed.risks ?? []).filter((r) => typeof r === "string").map((r) => String(r));

  const split =
    Array.isArray(parsed.split) && parsed.split.length > 0
      ? parsed.split.filter((s) => typeof s === "string").map((s) => String(s))
      : null;

  const similar: SimilarNote[] = (parsed.similar ?? [])
    .filter((s) => typeof s?.note === "string")
    .map((s) => ({
      key: typeof s.key === "string" ? s.key : null,
      pr: Number(s.pr) || 0,
      note: String(s.note),
    }));

  const duplicateFlag: DuplicateFlag = {
    suspected: Boolean(parsed.duplicateFlag?.suspected),
    why: typeof parsed.duplicateFlag?.why === "string" ? parsed.duplicateFlag.why : "",
  };

  return {
    estimatedLines: Math.max(0, Math.round(Number(parsed.estimatedLines) || 0)),
    difficulty: normalizeDifficulty(parsed.difficulty),
    score: clamp(Math.round(Number(parsed.score) || 5), 1, 10),
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    modules,
    risks,
    split,
    similar,
    duplicateFlag,
  };
}

export async function runCall2(
  store: Store,
  input: Call2PromptInput
): Promise<{ result: TaskAnalysis; usage: PipelineUsage }> {
  const { system, user } = buildCall2Prompt(input);
  const response = await directChatCompletion(store, { system, user, model: TASK_RADAR_MODEL });
  const result = parseCall2Response(response.content);
  return {
    result,
    usage: { promptTokens: response.promptTokens, completionTokens: response.completionTokens, calls: 1 },
  };
}
