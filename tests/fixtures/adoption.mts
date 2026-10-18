import { required } from "../../src/invariants.ts";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setupProject } from "../../src/projects.ts";
import { writeCollectionManifest } from "../../src/collections.ts";
import { collectionDecisionMap } from "../../src/collection-commands.ts";

export const distribution = resolve(import.meta.dirname, "../..");
export function git(root: string, ...args: string[]) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-C",
      root,
      ...args,
    ],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout.trim();
}
export async function consumer(id = "consumer") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-adoption-")));
  git(root, "init", "--quiet");
  await setupProject(root, id);
  cpSync(resolve(import.meta.dirname, "records/CHARTER.md"), join(root, "workbench/CHARTER.md"));
  return root;
}
export function provider(
  base: string,
  id = "company",
  revision = "1",
  bodies = ["Use a bounded retry budget."],
  visibility: "public" | "private" = "public",
  supporting: Record<string, string | Uint8Array> = {},
  charter?: string,
) {
  const directory = join(base, ".git/provider-fixtures", `${id}-${revision}`);
  const numbers = bodies.map((_, index) => index.toString(36).toUpperCase());
  mkdirSync(join(directory, "workbench/decisions"), { recursive: true });
  if (charter === undefined)
    cpSync(resolve(import.meta.dirname, "records/CHARTER.md"), join(directory, "workbench/CHARTER.md"));
  else writeFileSync(join(directory, "workbench/CHARTER.md"), charter);
  for (const [index, body] of bodies.entries()) {
    const number = numbers[index];
    writeFileSync(
      join(
        directory,
        `workbench/decisions/ADR-${required(number, "Expected fixture value: number").padStart(2, "0")}.md`,
      ),
      `---\nsummary: Policy ${String(number)}.\nagent_instruction: Policy ${String(number)}.\n---\n\n# ADR-${String(number)}: Policy ${String(number)}\n\n${body}\n`,
    );
  }
  for (const [name, bytes] of Object.entries(supporting)) {
    const path = join(directory, "workbench/decisions/ADR-00", name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
  }
  const collection = { id, decisions: numbers };
  writeFileSync(join(directory, "workbench/decision-map.md"), collectionDecisionMap(directory, collection));
  const pin = writeCollectionManifest(directory, { id, revision, visibility, decisions: numbers });
  git(directory, "init", "--quiet");
  git(directory, "add", ".");
  git(directory, "commit", "--quiet", "-m", "Collection fixture");
  return { directory, pin, commit: git(directory, "rev-parse", "HEAD") };
}
