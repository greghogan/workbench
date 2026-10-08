import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Group setup work without removing any root from the configured matrix.
function group(entries, fields) {
  const groups = new Map();
  for (const entry of entries) {
    const key = JSON.stringify(fields.map((field) => entry[field] ?? ""));
    let target = groups.get(key);
    if (!target) {
      target = { ...entry, paths: [], msvc: false };
      groups.set(key, target);
    }
    if (!target.paths.includes(entry.path)) target.paths.push(entry.path);
    target.msvc ||= Boolean(entry.llvm || entry.rust);
  }
  return [...groups.values()];
}

export function sharedPlan(matrix) {
  return {
    ...matrix,
    native: { include: group(matrix.native.include, ["os", "architecture", "runner", "node"]) },
    compatibility: {
      include: [
        ...group(
          matrix.compatibility.include.filter((entry) => ["node", "clang", "gcc"].includes(entry.runtime)),
          ["runtime", "version", "architecture", "runner", "node"],
        ),
        ...matrix.compatibility.include
          .filter((entry) => !["node", "clang", "gcc"].includes(entry.runtime))
          .map((entry) => ({ ...entry, paths: [entry.path] })),
      ],
    },
    environments: { include: group(matrix.environments.include, ["environment", "node"]) },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(sharedPlan(JSON.parse(readFileSync(0, "utf8")))));
