import type { ToolReferences } from "./tool-references.js";

/** Retention is per owned root, environment, CI target and exact tool selection, never across projects. */
export function supersededBuilds(
  references: ToolReferences,
  current: Set<string>,
  policy: { maxGenerations: number; maxAgeDays: number },
  now: number,
): Set<string> {
  const groups = new Map<string, { directory: string; used: number; verified: number }[]>();
  for (const reference of references.results) {
    if (reference.kind !== "builds" && reference.kind !== "dependencies") continue;
    // A cache shared between hosts must not retire another architecture's working generations.
    if (!reference.platform) continue;
    const used = Date.parse(reference.lastUsed ?? "");
    if (!Number.isFinite(used)) continue;
    const { checkout, root, environment, localCI } = reference.identity;
    const tools = reference.tools
      .map((tool) => JSON.stringify([tool.tool, tool.version, tool.directory ?? null]))
      .sort();
    const key = JSON.stringify([
      checkout,
      root,
      environment,
      localCI?.image,
      localCI?.target,
      reference.platform,
      reference.kind,
      tools,
    ]);
    const group = groups.get(key) ?? [];
    group.push({ directory: reference.directory, used, verified: Date.parse(reference.verifiedAt ?? "") });
    groups.set(key, group);
  }
  const selected = new Set<string>();
  for (const group of groups.values()) {
    const working = group.filter((entry) => Number.isFinite(entry.verified)).sort((a, b) => b.verified - a.verified)[0];
    if (!working) continue;
    group.sort((a, b) => b.used - a.used || a.directory.localeCompare(b.directory));
    const recent = new Set(
      group
        .filter((entry) => entry.directory !== working.directory)
        .slice(0, Math.max(0, policy.maxGenerations - 1))
        .map((entry) => entry.directory),
    );
    for (const entry of group) {
      if (
        entry.directory === working.directory ||
        current.has(entry.directory) ||
        entry.directory === group[0]?.directory
      )
        continue;
      const excess = policy.maxGenerations > 0 && !recent.has(entry.directory);
      const expired = policy.maxAgeDays > 0 && now - entry.used >= policy.maxAgeDays * 86_400_000;
      if (excess || expired) selected.add(entry.directory);
    }
  }
  return selected;
}
