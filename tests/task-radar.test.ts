import { describe, expect, it } from "bun:test";
import { jaccardSimilarity, overlapCount, tokenize } from "../scripts/task-radar/text.ts";
import {
  deriveModulePaths,
  matchModuleForFile,
  moduleByPath,
  pathsOverlap,
} from "../scripts/task-radar/project-map.ts";
import { isPackageBumpEntry, rankSimilarTasks } from "../scripts/task-radar/task-index.ts";
import { extractJson, JsonExtractionError } from "../scripts/task-radar/json-extract.ts";
import { parseCall1Response, parseCall2Response } from "../scripts/task-radar/codex-analysis.ts";
import { difficultyFromLines, precisionRecall, sumChangedLines } from "../scripts/task-radar/metrics.ts";
import { selectBenchmarkTasks } from "../scripts/task-radar/benchmark-selection.ts";
import { mapWithConcurrency } from "../scripts/task-radar/concurrency.ts";
import { computeHybridDifficulty } from "../scripts/task-radar/difficulty-hybrid.ts";
import type { ProjectModule, TaskIndexEntry } from "../scripts/task-radar/types.ts";

function makeModule(overrides: Partial<ProjectModule> = {}): ProjectModule {
  return {
    name: "app/Actions",
    path: "app/Actions",
    files: 5,
    classes: ["CreateNewUser"],
    summary: "Ações de autenticação e conta do usuário.",
    ...overrides,
  };
}

function makeEntry(overrides: Partial<TaskIndexEntry> = {}): TaskIndexEntry {
  return {
    key: "CE-1000",
    pr: 1,
    title: "feature/CE-1000",
    mergedAt: "2026-01-01T00:00:00Z",
    branch: "feature/CE-1000",
    files: [{ f: "app/Actions/CreateNewUser.php", add: 10, del: 2 }],
    ...overrides,
  };
}

describe("text tokenization and similarity", () => {
  it("removes portuguese stopwords and short tokens", () => {
    expect(tokenize("Arrumar o self-runner de CI/CD para a clínica")).toEqual([
      "arrumar",
      "self",
      "runner",
      "clinica",
    ]);
  });

  it("computes jaccard similarity between token sets", () => {
    expect(jaccardSimilarity(["a", "b", "c"], ["b", "c", "d"])).toBeCloseTo(0.5);
    expect(jaccardSimilarity([], ["a"])).toBe(0);
  });

  it("counts token overlap", () => {
    expect(overlapCount(["a", "b", "b"], ["b", "c"])).toBe(1);
  });
});

describe("project map matching", () => {
  const modules = [
    makeModule({ path: "app/Api/V1", name: "app/Api/V1" }),
    makeModule({ path: "app/Api/V1/Booking", name: "app/Api/V1/Booking" }),
    makeModule({ path: "app/Actions", name: "app/Actions" }),
  ];

  it("picks the most specific (longest) matching module for a file", () => {
    const match = matchModuleForFile("app/Api/V1/Booking/BookingController.php", modules);
    expect(match?.path).toBe("app/Api/V1/Booking");
  });

  it("falls back to a parent module when there is no specific match", () => {
    const match = matchModuleForFile("app/Api/V1/PatientController.php", modules);
    expect(match?.path).toBe("app/Api/V1");
  });

  it("returns null when no module matches", () => {
    expect(matchModuleForFile("resources/js/App.tsx", modules)).toBeNull();
  });

  it("derives unique module paths from a list of files", () => {
    const paths = deriveModulePaths(
      [
        { f: "app/Actions/CreateNewUser.php", add: 1, del: 0 },
        { f: "app/Actions/ResetPassword.php", add: 1, del: 0 },
        { f: "app/Api/V1/Booking/X.php", add: 1, del: 0 },
      ],
      modules
    );
    expect(paths.sort()).toEqual(["app/Actions", "app/Api/V1/Booking"]);
  });

  it("treats ancestor/descendant paths as overlapping", () => {
    expect(pathsOverlap("app/Api/V1", "app/Api/V1/Booking")).toBe(true);
    expect(pathsOverlap("app/Api/V1/Booking", "app/Api/V1")).toBe(true);
    expect(pathsOverlap("app/Actions", "app/Api/V1")).toBe(false);
  });

  it("looks up a module by exact path", () => {
    expect(moduleByPath("app/Actions", modules)?.name).toBe("app/Actions");
    expect(moduleByPath("app/Missing", modules)).toBeNull();
  });
});

describe("similar task ranking", () => {
  const modules = [makeModule({ path: "app/Actions" })];
  const entries: TaskIndexEntry[] = [
    makeEntry({ key: "CE-1", pr: 1, title: "Ajustar cadastro de clínica" }),
    makeEntry({ key: "CE-2", pr: 2, title: "Corrigir agenda de profissional" }),
    makeEntry({ key: "CE-3", pr: 3, title: "Reset de senha na conta do usuário" }),
  ];

  it("ranks entries by title token overlap, most similar first", () => {
    const ranked = rankSimilarTasks("Corrigir reset de senha do usuário", entries, modules, {
      topN: 15,
    });
    expect(ranked[0]?.key).toBe("CE-3");
    expect(ranked.map((r) => r.key)).toContain("CE-2");
  });

  it("excludes tasks by key and by PR number", () => {
    const ranked = rankSimilarTasks("Reset de senha do usuário", entries, modules, {
      excludeKeys: new Set(["CE-3"]),
      excludePrs: new Set([1]),
      topN: 15,
    });
    expect(ranked.some((r) => r.key === "CE-3")).toBe(false);
    expect(ranked.some((r) => r.pr === 1)).toBe(false);
  });

  it("respects the topN cap", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      makeEntry({ key: `CE-${i}`, pr: i, title: "Reset de senha do usuário" })
    );
    const ranked = rankSimilarTasks("Reset de senha do usuário", many, modules, { topN: 15 });
    expect(ranked.length).toBe(15);
  });

  it("scores using jiraTitle instead of the branch-derived title when present", () => {
    const enriched: TaskIndexEntry[] = [
      makeEntry({ key: "CE-9", pr: 9, title: "feature/CE-9", jiraTitle: "Corrigir reset de senha do usuário" }),
      makeEntry({ key: "CE-8", pr: 8, title: "Corrigir reset de senha do usuário" }),
    ];
    const ranked = rankSimilarTasks("Corrigir reset de senha do usuário", enriched, modules, { topN: 15 });
    expect(ranked.find((r) => r.key === "CE-9")?.score).toBeGreaterThan(0);
    expect(ranked.find((r) => r.key === "CE-9")?.score).toBe(ranked.find((r) => r.key === "CE-8")?.score);
    expect(ranked.find((r) => r.key === "CE-9")?.title).toBe("feature/CE-9");
  });
});

describe("package bump entry filtering", () => {
  it("flags a title matching the bump pattern (pt-BR)", () => {
    expect(
      isPackageBumpEntry(
        makeEntry({ key: null, title: "chore: atualiza versão do composer", branch: "feature/CE-1" })
      )
    ).toBe(true);
  });

  it("flags a title matching the bump pattern (english)", () => {
    expect(
      isPackageBumpEntry(makeEntry({ key: null, title: "bump package dependency", branch: "feature/CE-1" }))
    ).toBe(true);
  });

  it("flags branches named update-* or bump-*", () => {
    expect(isPackageBumpEntry(makeEntry({ branch: "update-composer-lock", title: "manutenção" }))).toBe(true);
    expect(isPackageBumpEntry(makeEntry({ branch: "chore/bump-deps", title: "manutenção" }))).toBe(true);
  });

  it("flags entries where >=80% of files are package manifests/lockfiles", () => {
    expect(
      isPackageBumpEntry(
        makeEntry({
          title: "manutenção de dependências",
          branch: "feature/CE-1",
          files: [
            { f: "composer.json", add: 1, del: 1 },
            { f: "composer.lock", add: 1, del: 1 },
            { f: "package.json", add: 1, del: 1 },
            { f: "package-lock.json", add: 1, del: 1 },
            { f: "app/Models/User.php", add: 1, del: 0 },
          ],
        })
      )
    ).toBe(true);
  });

  it("flags null-key entries with <=2 config-only files", () => {
    expect(
      isPackageBumpEntry(
        makeEntry({
          key: null,
          title: "Staging",
          branch: "staging",
          files: [{ f: "package-lock.json", add: 1, del: 1 }],
        })
      )
    ).toBe(true);
  });

  it("does not flag real feature work touching package files incidentally", () => {
    expect(
      isPackageBumpEntry(
        makeEntry({
          title: "Ajustar cadastro de clínica",
          branch: "feature/CE-1000",
          files: [
            { f: "app/Actions/CreateNewUser.php", add: 10, del: 2 },
            { f: "app/Services/Clinic/CreateClinicService.php", add: 5, del: 0 },
            { f: "composer.json", add: 1, del: 1 },
          ],
        })
      )
    ).toBe(false);
  });

  it("does not flag when the package-file ratio stays below the 80% threshold, regardless of key", () => {
    expect(
      isPackageBumpEntry(
        makeEntry({
          key: "CE-1",
          title: "Ajustar dependência do módulo de checkout",
          branch: "feature/CE-1",
          files: [
            { f: "composer.json", add: 1, del: 1 },
            { f: "composer.lock", add: 1, del: 1 },
            { f: "app/Services/Checkout/CheckoutService.php", add: 30, del: 0 },
          ],
        })
      )
    ).toBe(false);
  });
});

describe("JSON extraction from LLM output", () => {
  it("parses plain JSON", () => {
    expect(extractJson<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
  });

  it("parses JSON wrapped in a markdown fence", () => {
    expect(extractJson<{ a: number }>('```json\n{"a": 2}\n```')).toEqual({ a: 2 });
  });

  it("extracts a balanced JSON object surrounded by prose", () => {
    expect(extractJson<{ a: number }>('Aqui está: {"a": 3} — espero ter ajudado')).toEqual({ a: 3 });
  });

  it("throws a descriptive error when no JSON is found", () => {
    expect(() => extractJson("não há json aqui")).toThrow(JsonExtractionError);
  });
});

describe("codex response parsing", () => {
  it("normalizes a valid call1 response", () => {
    const parsed = parseCall1Response(
      JSON.stringify({
        candidateModules: [{ path: "app/Actions", reason: "toca autenticação" }],
        similarTasks: ["CE-1", 42, ""],
        needsCode: ["a.php", "b.php", "c.php", "d.php", "e.php", "f.php", "g.php"],
      })
    );
    expect(parsed.candidateModules).toEqual([{ path: "app/Actions", reason: "toca autenticação" }]);
    expect(parsed.similarTasks).toEqual(["CE-1"]);
    expect(parsed.needsCode.length).toBe(6);
  });

  it("clamps and normalizes a call2 response", () => {
    const parsed = parseCall2Response(
      JSON.stringify({
        difficulty: "x",
        score: 99,
        rationale: "ok",
        modules: [{ path: "app/Actions", confidence: 2, what: "muda regra" }],
        risks: ["quebra fluxo de login"],
        split: [],
        similar: [{ key: "CE-1", pr: "10", note: "mesmo fluxo" }],
        duplicateFlag: { suspected: true, why: "já existe PR aberto" },
      })
    );
    expect(parsed.difficulty).toBe("M");
    expect(parsed.score).toBe(10);
    expect(parsed.modules[0]?.confidence).toBe(1);
    expect(parsed.split).toBeNull();
    expect(parsed.similar[0]?.pr).toBe(10);
    expect(parsed.duplicateFlag.suspected).toBe(true);
  });
});

describe("benchmark metrics", () => {
  it("scores perfect precision and recall when predictions match exactly", () => {
    const { precision, recall } = precisionRecall(["app/Actions"], ["app/Actions"]);
    expect(precision).toBe(1);
    expect(recall).toBe(1);
  });

  it("treats ancestor/descendant paths as a match", () => {
    const { precision, recall } = precisionRecall(["app/Api/V1"], ["app/Api/V1/Booking"]);
    expect(precision).toBe(1);
    expect(recall).toBe(1);
  });

  it("penalizes false positives and misses", () => {
    const { precision, recall } = precisionRecall(["app/Actions", "app/Wrong"], ["app/Actions", "app/Missed"]);
    expect(precision).toBeCloseTo(0.5);
    expect(recall).toBeCloseTo(0.5);
  });

  it("scores 1/1 when nothing was expected and nothing was predicted", () => {
    expect(precisionRecall([], [])).toEqual({ precision: 1, recall: 1 });
  });

  it("sums added and deleted lines across files", () => {
    expect(
      sumChangedLines([
        { f: "a.php", add: 10, del: 5 },
        { f: "b.php", add: 3, del: 0 },
      ])
    ).toBe(18);
  });

  it("buckets difficulty by changed line thresholds", () => {
    expect(difficultyFromLines(0)).toBe("P");
    expect(difficultyFromLines(149)).toBe("P");
    expect(difficultyFromLines(150)).toBe("M");
    expect(difficultyFromLines(600)).toBe("M");
    expect(difficultyFromLines(601)).toBe("G");
  });
});

describe("hybrid difficulty with enriched titles", () => {
  it("finds mechanical similars via jiraTitle even when branch titles carry no semantics", () => {
    const taskIndex: TaskIndexEntry[] = [
      makeEntry({
        key: "CE-101",
        pr: 101,
        title: "feature/CE-101",
        jiraTitle: "Corrigir cálculo de agenda do profissional",
        files: [{ f: "app/Actions/A.php", add: 100, del: 20 }],
      }),
      makeEntry({
        key: "CE-102",
        pr: 102,
        title: "hotfix/CE-102",
        jiraTitle: "Corrigir cálculo de agenda do profissional na clínica",
        files: [{ f: "app/Actions/B.php", add: 200, del: 40 }],
      }),
    ];

    const result = computeHybridDifficulty(
      "Corrigir cálculo de agenda do profissional",
      taskIndex,
      "P",
      new Set()
    );

    expect(result.source).toBe("mechanical");
    expect(result.similarCount).toBe(2);
  });

  it("falls back to the model guess when branch titles have no jiraTitle enrichment", () => {
    const taskIndex: TaskIndexEntry[] = [
      makeEntry({ key: "CE-201", pr: 201, title: "feature/CE-201" }),
      makeEntry({ key: "CE-202", pr: 202, title: "hotfix/CE-202" }),
    ];

    const result = computeHybridDifficulty(
      "Corrigir cálculo de agenda do profissional",
      taskIndex,
      "G",
      new Set()
    );

    expect(result.source).toBe("model");
    expect(result.difficulty).toBe("G");
  });
});

describe("benchmark task selection", () => {
  it("picks one representative entry per key, requiring >=3 files", () => {
    const entries: TaskIndexEntry[] = [
      makeEntry({ key: "CE-1", pr: 1, mergedAt: "2026-01-01T00:00:00Z", files: [
        { f: "a.php", add: 1, del: 0 },
        { f: "b.php", add: 1, del: 0 },
      ] }),
      makeEntry({ key: "CE-1", pr: 2, mergedAt: "2026-02-01T00:00:00Z", files: [
        { f: "a.php", add: 1, del: 0 },
        { f: "b.php", add: 1, del: 0 },
        { f: "c.php", add: 1, del: 0 },
      ] }),
      makeEntry({ key: "CE-2", pr: 3, mergedAt: "2026-03-01T00:00:00Z", files: [
        { f: "a.php", add: 1, del: 0 },
      ] }),
      makeEntry({ key: null as unknown as string, pr: 4, mergedAt: "2026-04-01T00:00:00Z", files: [
        { f: "a.php", add: 1, del: 0 },
        { f: "b.php", add: 1, del: 0 },
        { f: "c.php", add: 1, del: 0 },
      ] }),
    ];

    const selected = selectBenchmarkTasks(entries, 20);
    expect(selected.length).toBe(1);
    expect(selected[0]?.key).toBe("CE-1");
    expect(selected[0]?.representativeEntry.pr).toBe(2);
    expect(selected[0]?.allEntries.length).toBe(2);
  });

  it("orders selected tasks by most recent representative entry first and caps at count", () => {
    const entries: TaskIndexEntry[] = Array.from({ length: 25 }, (_, i) =>
      makeEntry({
        key: `CE-${i}`,
        pr: i,
        mergedAt: new Date(2026, 0, i + 1).toISOString(),
        files: [
          { f: "a.php", add: 1, del: 0 },
          { f: "b.php", add: 1, del: 0 },
          { f: "c.php", add: 1, del: 0 },
        ],
      })
    );

    const selected = selectBenchmarkTasks(entries, 20);
    expect(selected.length).toBe(20);
    expect(selected[0]?.key).toBe("CE-24");
    expect(selected[19]?.key).toBe("CE-5");
  });
});

describe("mapWithConcurrency", () => {
  it("preserves output order regardless of completion order", async () => {
    const results = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(results).toEqual([30, 10, 20]);
  });

  it("never runs more than the configured concurrency at once", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await mapWithConcurrency(items, 3, async (i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return i;
    });

    expect(maxActive).toBeLessThanOrEqual(3);
  });
});
