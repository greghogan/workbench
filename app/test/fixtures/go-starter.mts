import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { catalog } from "../../src/core/configuration/language-config.ts";
import { required } from "../../src/core/runtime/invariants.ts";

export const goCountFixture = join(import.meta.dirname, "starters/go/count.go");

/** Exercise Go starter publication using an independently owned implementation file. */
export function goStarterDistribution(source: string, directory: string) {
  const root = join(directory, "go-starter-distribution");
  if (existsSync(root)) return root;
  const go = required(
    catalog(source).find(({ id }) => id === "go"),
    "Go starter definition",
  );
  cpSync(join(source, "languages"), join(root, "languages"), { recursive: true });
  copyFileSync(join(source, "Makefile"), join(root, "Makefile"));
  for (const path of go.starter ?? []) {
    if (go.starter_assets?.some(({ path: asset }) => asset === path)) continue;
    const destination = join(root, go.reference, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(path === "count.go" ? goCountFixture : join(source, go.reference, path), destination);
  }
  return root;
}
