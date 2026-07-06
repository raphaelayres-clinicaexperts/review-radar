export function commentableLines(patch?: string): Set<number> {
  const set = new Set<number>();
  if (!patch) return set;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      newLine = Number(h[1]);
      continue;
    }
    if (line.startsWith("+")) {
      set.add(newLine);
      newLine++;
    } else if (line.startsWith("-")) {
      continue;
    } else {
      set.add(newLine);
      newLine++;
    }
  }
  return set;
}
