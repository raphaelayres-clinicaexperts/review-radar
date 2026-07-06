// Task Radar v7 — rerank listwise (1 chamada LLM) sobre os candidatos do retrieve.ts.
//
// retrieve.ts já faz o trabalho pesado de achar candidatos SEM LLM (4 sinais, R@20=85.5%
// no benchmark de retrieval). Este módulo pega o top-20 e pede pro modelo revisar em uma
// única chamada listwise: manter só o que precisa de mudança real de código, descartar o
// resto, com confidence + justificativa curta por módulo. Sem cap artificial — o modelo
// decide quantos ficam.
//
// Uso: bun run scripts/task-radar-v7/rerank.ts "Corrigir erro ao carregar usuários no admin"

import { join } from "node:path";
import { directChatCompletion } from "../../lambda/codex-client.ts";
import { FsStore, type Store } from "../../lambda/store.ts";
import { extractJson } from "../task-radar/json-extract.ts";
import { loadProjectMap, moduleByPath } from "../task-radar/project-map.ts";
import { loadTaskIndex, rankSimilarTasks } from "../task-radar/task-index.ts";
import type { PipelineUsage, ProjectModule, SimilarTaskRef, TaskIndexEntry, TaskInput } from "../task-radar/types.ts";
import { CONFIG, type RetrievedModule, type RetrieveWeights } from "./retrieve.ts";

// Mesmo mecanismo de override de retrieve.ts: em Lambda, TASK_RADAR_DATA_DIR aponta pro
// diretório /tmp onde lambda/task-radar-artifacts.ts baixou os artefatos do S3. Computado sob
// demanda (não em const de topo) pelo mesmo motivo documentado em retrieve.ts: o bundle da
// Lambda inlina este módulo no cold start, antes da env var existir.
function projectMapPath(): string {
  return join(process.env.TASK_RADAR_DATA_DIR || join(import.meta.dir, "../.."), "project-map.json");
}
function taskIndexPath(): string {
  return join(process.env.TASK_RADAR_DATA_DIR || join(import.meta.dir, "../.."), "task-index.json");
}

// Mesmo mecanismo de override de modelo do pipeline v1-v6: sem a env, directChatCompletion
// cai no resolveCodexModel(undefined) → DEFAULT_CODEX_MODEL (gpt-5.4-mini).
const TASK_RADAR_MODEL = process.env.TASK_RADAR_MODEL?.trim() || undefined;

export interface RerankedModule {
  path: string;
  confidence: number;
  why: string;
}

export interface RerankResult {
  modules: RerankedModule[];
  technicalSummary: string[];
  usage: PipelineUsage;
}

export interface RerankOptions {
  excludeKeys?: Set<string>;
  excludePrs?: Set<number>;
}

let _modules: ProjectModule[] | null = null;
function getModules(): ProjectModule[] {
  if (!_modules) _modules = loadProjectMap(projectMapPath()).modules;
  return _modules;
}

let _taskIndex: TaskIndexEntry[] | null = null;
function getTaskIndex(): TaskIndexEntry[] {
  if (!_taskIndex) _taskIndex = loadTaskIndex(taskIndexPath());
  return _taskIndex;
}

// ---------------------------------------------------------------------------
// Evidência por candidato: qual dos 4 sinais do retrieve.ts foi o principal
// responsável por trazer este módulo, em texto legível pro modelo (e pro humano
// lendo o prompt depois). Usa o mesmo peso vencedor (CONFIG.weights) pra decidir
// o sinal dominante — consistente com como retrieve.ts realmente pontuou o módulo.
// ---------------------------------------------------------------------------

function dominantSignal(candidate: RetrievedModule, weights: RetrieveWeights): keyof RetrieveWeights {
  const weighted: Record<keyof RetrieveWeights, number> = {
    titleSim: weights.titleSim * candidate.signals.titleSim,
    fts: weights.fts * candidate.signals.fts,
    cochange: weights.cochange * candidate.signals.cochange,
    centrality: weights.centrality * candidate.signals.centrality,
  };
  return (Object.entries(weighted) as Array<[keyof RetrieveWeights, number]>).sort((a, b) => b[1] - a[1])[0]![0];
}

function buildEvidence(
  candidate: RetrievedModule,
  similarTasks: SimilarTaskRef[],
  weights: RetrieveWeights
): string {
  switch (dominantSignal(candidate, weights)) {
    case "titleSim": {
      const best = similarTasks
        .filter((s) => s.modules.includes(candidate.path))
        .sort((a, b) => b.score - a.score)[0];
      if (best) {
        return `task similar ${best.key ?? `PR #${best.pr}`} ("${best.title}") mexeu aqui`;
      }
      return "similaridade de título com histórico de tasks";
    }
    case "fts":
      return "correspondência lexical (FTS) entre o texto da task e o resumo/classes do módulo";
    case "cochange":
      return "módulo costuma mudar junto (co-change) com outros candidatos desta task";
    case "centrality":
    default:
      return "módulo central no grafo de dependências de código (alta centralidade)";
  }
}

interface CandidateForPrompt {
  path: string;
  score: number;
  summary: string;
  classes: string[];
  evidence: string;
}

function buildCandidatesForPrompt(
  candidates: RetrievedModule[],
  similarTasks: SimilarTaskRef[]
): CandidateForPrompt[] {
  const modules = getModules();
  return candidates.map((c) => {
    const module = moduleByPath(c.path, modules);
    return {
      path: c.path,
      score: c.score,
      summary: module?.summary ?? "(módulo não encontrado no mapa)",
      classes: module?.classes ?? [],
      evidence: buildEvidence(c, similarTasks, CONFIG.weights),
    };
  });
}

// ---------------------------------------------------------------------------
// Prompt listwise
// ---------------------------------------------------------------------------

const SYSTEM_RERANK = [
  "Você é um analista técnico sênior de engenharia de software, especialista no codebase de um",
  "sistema de clínicas médicas em Laravel/PHP. Você recebe uma task do Jira e uma lista de módulos",
  "candidatos trazidos por um retrieval automático (sem LLM, baseado em sinais textuais/estruturais).",
  "Sua tarefa é revisar essa lista e decidir, com julgamento técnico, quais módulos realmente",
  "precisam de alteração de código para esta task. Responda SEMPRE em português brasileiro e",
  "SEMPRE com um único objeto JSON válido, sem texto fora do JSON e sem blocos de markdown.",
].join(" ");

function taskBlock(task: TaskInput): string {
  return [
    `Chave: ${task.key ?? "(nova task, sem chave ainda)"}`,
    `Tipo: ${task.issueType ?? "desconhecido"}`,
    `Título: ${task.title}`,
    `Descrição:\n${task.description || "(sem descrição)"}`,
  ].join("\n");
}

function formatCandidatesForPrompt(candidates: CandidateForPrompt[]): string {
  if (candidates.length === 0) return "(nenhum módulo candidato retornado pelo retrieval)";
  return candidates
    .map(
      (c, i) =>
        `${i + 1}. ${c.path} — score retrieval: ${c.score.toFixed(3)}\n` +
        `   evidência (sinal dominante): ${c.evidence}\n` +
        `   resumo: ${c.summary}\n` +
        `   classes principais: ${c.classes.length ? c.classes.slice(0, 10).join(", ") : "(nenhuma)"}`
    )
    .join("\n\n");
}

export function buildRerankPrompt(
  task: TaskInput,
  candidates: CandidateForPrompt[]
): { system: string; user: string } {
  const user = [
    "## Task a analisar",
    taskBlock(task),
    "",
    `## Módulos candidatos (top ${candidates.length}, trazidos por retrieval automático sem LLM)`,
    formatCandidatesForPrompt(candidates),
    "",
    "## O que fazer",
    "1. Revise CADA módulo candidato acima e decida se ele provavelmente precisa de alteração",
    "   REAL de código para esta task específica — não inclua módulos apenas 'possivelmente",
    "   relacionados', adjacentes ou tangenciais. A evidência do retrieval é um indício, não uma",
    "   confirmação: use seu julgamento sobre a task e o resumo/classes do módulo.",
    "2. NÃO existe limite de quantidade — inclua TODOS os módulos que fazem sentido (mesmo que",
    "   sejam muitos) e rejeite (não inclua na saída) todos os que não fazem, mesmo que tenham",
    "   score de retrieval alto.",
    "3. Para cada módulo mantido, dê um confidence de 0 a 1 (1 = certeza alta de que precisa mudar)",
    "   e um `why` de uma frase curta explicando o motivo (baseado na task, não repita a evidência crua).",
    "4. Ordene a saída por confidence decrescente.",
    "5. Escreva um `technicalSummary`: 3 a 4 bullets em português brasileiro, objetivos, descrevendo",
    "   O QUE fazer tecnicamente — quais mudanças de código fazer, em quais módulos/arquivos (use os",
    "   paths dos módulos mantidos) e em que ordem. Baseie-se na task, nos módulos mantidos e na",
    "   evidência de cada um. Sem generalidades ('ajustar o sistema') — seja concreto e acionável.",
    "",
    "## Formato de saída — responda APENAS este JSON:",
    "{",
    '  "modules": [{ "path": "app/...", "confidence": 0.9, "why": "..." }],',
    '  "technicalSummary": ["...", "...", "..."]',
    "}",
  ].join("\n");

  return { system: SYSTEM_RERANK, user };
}

interface RawRerankResponse {
  modules?: Array<{ path?: unknown; confidence?: unknown; why?: unknown }>;
  technicalSummary?: unknown;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function parseRerankResponse(raw: string, allowedPaths: Set<string>): RerankedModule[] {
  const parsed = extractJson<RawRerankResponse>(raw);
  return (parsed.modules ?? [])
    .filter((m) => typeof m?.path === "string" && allowedPaths.has(String(m.path)))
    .map((m) => ({
      path: String(m.path),
      confidence: clamp(Number(m.confidence) || 0, 0, 1),
      why: typeof m.why === "string" ? m.why : "",
    }))
    .sort((a, b) => b.confidence - a.confidence);
}

export function parseTechnicalSummary(raw: string): string[] {
  const parsed = extractJson<RawRerankResponse>(raw);
  if (!Array.isArray(parsed.technicalSummary)) return [];
  return parsed.technicalSummary.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

export async function rerankModules(
  store: Store,
  task: TaskInput,
  candidates: RetrievedModule[],
  options: RerankOptions = {}
): Promise<RerankResult> {
  if (candidates.length === 0) {
    return { modules: [], technicalSummary: [], usage: { promptTokens: 0, completionTokens: 0, calls: 0 } };
  }

  const similarTasks = rankSimilarTasks(task.title, getTaskIndex(), getModules(), {
    excludeKeys: options.excludeKeys,
    excludePrs: options.excludePrs,
    topN: CONFIG.topPRsForTitle,
  }).filter((s) => s.score > 0);

  const candidatesForPrompt = buildCandidatesForPrompt(candidates, similarTasks);
  const { system, user } = buildRerankPrompt(task, candidatesForPrompt);

  const response = await directChatCompletion(store, { system, user, model: TASK_RADAR_MODEL });
  const allowedPaths = new Set(candidates.map((c) => c.path));
  const modules = parseRerankResponse(response.content, allowedPaths);
  const technicalSummary = parseTechnicalSummary(response.content);

  return {
    modules,
    technicalSummary,
    usage: { promptTokens: response.promptTokens, completionTokens: response.completionTokens, calls: 1 },
  };
}

if (import.meta.main) {
  const { retrieveModules } = await import("./retrieve.ts");
  const sampleText = process.argv[2] ?? "Corrigir erro ao carregar usuários no admin";
  const task: TaskInput = { key: null, title: sampleText, description: "", issueType: null };
  const candidates = await retrieveModules(sampleText);
  const store = new FsStore();
  const result = await rerankModules(store, task, candidates);
  console.log(JSON.stringify(result, null, 2));
}
