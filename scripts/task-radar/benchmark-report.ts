export interface BenchmarkTaskRow {
  key: string;
  title: string;
  jiraFallback: boolean;
  precision: number;
  recall: number;
  precisionConf50?: number;
  recallConf50?: number;
  predictedDifficulty: string;
  realDifficultyProxy: string;
  difficultyMatch: boolean;
  difficultySource?: string;
  similarCount?: number;
  error?: string;
}

export interface BenchmarkAggregate {
  tasksTotal: number;
  tasksOk: number;
  tasksFailed: number;
  meanPrecision: number;
  meanRecall: number;
  meanPrecisionConf50?: number;
  meanRecallConf50?: number;
  difficultyAccuracyPct: number;
  difficultySourceCounts?: Record<string, number>;
  // Quantas das tasks avaliadas encontraram >=2 tasks históricas similares por título
  // (jiraTitle ?? title) — ou seja, tiveram régua mecânica de dificuldade disponível em vez
  // de cair no palpite do modelo por falta de histórico.
  tasksWithSufficientSimilars?: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCalls: number;
  elapsedSeconds: number;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

export function toMarkdownTable(rows: BenchmarkTaskRow[], aggregate: BenchmarkAggregate): string {
  const lines: string[] = [];

  lines.push("# Benchmark — Task Radar");
  lines.push("");
  lines.push("| Key | Título | P (todos) | R (todos) | P (conf≥0.5) | R (conf≥0.5) | Dif. prevista | Dif. proxy | Acerto | Fonte dif. | Obs |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const row of rows) {
    if (row.error) {
      lines.push(`| ${row.key} | ${row.title} | - | - | - | - | - | - | - | - | ERRO: ${row.error} |`);
      continue;
    }
    const obs = row.jiraFallback ? "título via PR (404 no Jira)" : "";
    lines.push(
      `| ${row.key} | ${row.title.slice(0, 40)} | ${pct(row.precision)} | ${pct(row.recall)} | ${pct(row.precisionConf50 ?? 0)} | ${pct(row.recallConf50 ?? 0)} | ${row.predictedDifficulty} | ${row.realDifficultyProxy} | ${row.difficultyMatch ? "✅" : "❌"} | ${row.difficultySource ?? "-"} | ${obs} |`
    );
  }
  lines.push("");
  lines.push("## Agregado");
  lines.push(`- Tasks avaliadas: ${aggregate.tasksOk}/${aggregate.tasksTotal} (${aggregate.tasksFailed} falharam)`);
  lines.push(`- Precisão média (todos os módulos previstos): ${pct(aggregate.meanPrecision)}`);
  lines.push(`- Recall médio (todos os módulos previstos): ${pct(aggregate.meanRecall)}`);
  lines.push(`- Precisão média (corte confidence ≥ 0.5): ${pct(aggregate.meanPrecisionConf50 ?? 0)}`);
  lines.push(`- Recall médio (corte confidence ≥ 0.5): ${pct(aggregate.meanRecallConf50 ?? 0)}`);
  lines.push(`- Acerto de dificuldade: ${aggregate.difficultyAccuracyPct.toFixed(0)}%`);
  if (aggregate.difficultySourceCounts) {
    const counts = Object.entries(aggregate.difficultySourceCounts)
      .map(([source, count]) => `${source}=${count}`)
      .join(", ");
    lines.push(`- Fonte da dificuldade: ${counts}`);
  }
  if (aggregate.tasksWithSufficientSimilars !== undefined) {
    lines.push(
      `- Tasks com >=2 similares ativos: ${aggregate.tasksWithSufficientSimilars}/${aggregate.tasksOk}`
    );
  }
  lines.push(
    `- Tokens: ${aggregate.totalPromptTokens} in / ${aggregate.totalCompletionTokens} out (${aggregate.totalCalls} chamadas Codex)`
  );
  lines.push(`- Tempo total: ${aggregate.elapsedSeconds.toFixed(1)}s`);

  return lines.join("\n");
}
