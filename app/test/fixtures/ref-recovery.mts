import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "vitest";
import { repositoryStatePath } from "../../src/core/git/repository-state.ts";
import { gitBytes } from "../../src/core/git/git-snapshot.ts";
import type { PreparedRefMove } from "../../src/core/git/finalization-refs.ts";
import { git } from "./adoption.mjs";

export type RefFormat = "files" | "reftable";
export const refActivationInterrupted = "Interrupted fixture ref activation";
export const recoveryCases = [
  ["files", "before"],
  ["files", "partial"],
  ["files", "after"],
  ["reftable", "before"],
  ["reftable", "after"],
] as const;

export function initRefFormat(root: string, format: RefFormat, { skip }: TestContext): void {
  if (format === "files") {
    git(root, "init", "-qb", "main");
    return;
  }
  const result = spawnSync("git", ["-C", root, "init", "-qb", "main", "--ref-format=reftable"], { encoding: "utf8" });
  if (/unknown option.*ref-format/.test(result.stderr)) skip("Git does not support reftable");
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
}

export function linkedCheckout(root: string, branch: string, oid = "HEAD"): string {
  const checkout = repositoryStatePath(root, "linked-checkout");
  git(root, "worktree", "add", "-qb", branch, checkout, oid);
  return checkout;
}

export function stopBeforeRefActivation(root: string): () => void {
  const hooks = repositoryStatePath(root, "rewrite-hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(
    join(hooks, "reference-transaction"),
    `#!/bin/sh
if [ "$1" = prepared ]; then
  while read -r old new ref; do
    if [ "$ref" = refs/tags/recovery-test ]; then
      printf '%s\\n' '${refActivationInterrupted}' >&2
      exit 1
    fi
  done
fi
`,
    { mode: 0o755 },
  );
  git(root, "config", "core.hooksPath", hooks);
  return () => {
    git(root, "config", "--unset", "core.hooksPath");
  };
}

export function preparedMoves(root: string, operation: "finalization" | "signing"): PreparedRefMove[] {
  return (
    JSON.parse(readFileSync(repositoryStatePath(root, `${operation}-operation.json`), "utf8")) as {
      moves: PreparedRefMove[];
    }
  ).moves;
}

export function applyInterruptedMoves(root: string, moves: PreparedRefMove[], stage: "before" | "partial" | "after") {
  const changed = stage === "before" ? [] : stage === "partial" ? moves.slice(0, 1) : moves;
  if (changed.length)
    gitBytes(
      root,
      ["update-ref", "--stdin"],
      changed.map(({ name, after, before }) => `update ${name} ${after} ${before}\n`).join(""),
    );
}
