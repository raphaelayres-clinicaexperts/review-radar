import { describe, expect, it } from "bun:test";
import {
  buildCodeGraphFromFiles,
  extractBodyReferences,
  extractUseTargets,
  resolveFqcnToPath,
  sortedPsr4Entries,
  type Psr4Map,
} from "../scripts/task-radar-v7/code-graph-core.ts";

describe("PSR-4 resolution", () => {
  it("orders prefixes from most to least specific", () => {
    const psr4: Psr4Map = { "App\\": "app/", "Database\\Factories\\": "database/factories/" };
    expect(sortedPsr4Entries(psr4)).toEqual([
      ["Database\\Factories\\", "database/factories/"],
      ["App\\", "app/"],
    ]);
  });

  it("resolves a FQCN to a file path using the longest matching prefix", () => {
    const entries = sortedPsr4Entries({ "App\\": "app/", "Database\\Factories\\": "database/factories/" });
    expect(resolveFqcnToPath("App\\Models\\User", entries)).toBe("app/Models/User.php");
    expect(resolveFqcnToPath("Database\\Factories\\UserFactory", entries)).toBe(
      "database/factories/UserFactory.php"
    );
  });

  it("returns null for namespaces outside any PSR-4 prefix", () => {
    const entries = sortedPsr4Entries({ "App\\": "app/" });
    expect(resolveFqcnToPath("Illuminate\\Support\\Str", entries)).toBeNull();
  });
});

describe("use/FQCN extraction", () => {
  it("extracts plain and grouped use targets, ignoring aliases", () => {
    const content = `<?php\nuse App\\Models\\User;\nuse App\\Models\\{Team, Role as R};\n`;
    expect(extractUseTargets(content)).toEqual(["App\\Models\\User", "App\\Models\\Team", "App\\Models\\Role"]);
  });

  it("extracts fully-qualified App\\ references from the body", () => {
    const content = `class X { function f() { return new \\App\\Models\\Team(); } }`;
    expect(extractBodyReferences(content)).toEqual(["App\\Models\\Team"]);
  });
});

describe("buildCodeGraphFromFiles", () => {
  it("builds nodes/edges from use statements and ranks the referenced file higher", () => {
    const files = new Map<string, string>([
      ["app/Models/User.php", `<?php\nnamespace App\\Models;\nuse App\\Models\\Team;\nclass User {}\n`],
      ["app/Models/Team.php", `<?php\nnamespace App\\Models;\nclass Team {}\n`],
    ]);
    const psr4: Psr4Map = { "App\\": "app/" };

    const graph = buildCodeGraphFromFiles(files, psr4);

    expect(graph.nodeCount).toBe(2);
    expect(graph.edgeCount).toBe(1);
    const userIdx = graph.nodes.indexOf("app/Models/User.php");
    const teamIdx = graph.nodes.indexOf("app/Models/Team.php");
    expect(graph.edges[userIdx]).toEqual([teamIdx]);
    expect(graph.pagerank[teamIdx]!).toBeGreaterThan(graph.pagerank[userIdx]!);
  });

  it("counts unresolved references (external libs, missing files) without crashing", () => {
    const files = new Map<string, string>([
      ["app/Models/User.php", `<?php\nuse Illuminate\\Support\\Str;\nuse App\\Missing\\Ghost;\nclass User {}\n`],
    ]);
    const graph = buildCodeGraphFromFiles(files, { "App\\": "app/" });

    expect(graph.nodeCount).toBe(1);
    expect(graph.edgeCount).toBe(0);
    expect(graph.unresolvedCount).toBe(2);
  });
});
