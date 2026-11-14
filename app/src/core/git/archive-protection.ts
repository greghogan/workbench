import { distributionRoot } from "../projects/project-context.js";
import { copyFileToDescriptor } from "../runtime/file-reads.js";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { writeAtomic } from "../runtime/file-publication.mjs";
import { gitBytes } from "./git-snapshot.js";
import { repositoryStatePath } from "./repository-state.js";
import { validateBranch } from "./refs.js";
import { verifyArchiveHistory } from "../records/archive-store.js";

const hookNames = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
  "reference-transaction",
  "push-to-checkout",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "fsmonitor-watchman",
  "p4-changelist",
  "p4-prepare-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
  "post-index-change",
];
const quote = (text: string) =>
  "'" + (process.platform === "win32" ? text.replaceAll("\\", "/") : text).replaceAll("'", "'\\''") + "'";

/** A repository-local router keeps archive guards available even in an archive-only checkout. */
export function protectArchiveBranch(root: string, branch: string): void {
  validateBranch(root, branch);
  const router = repositoryStatePath(root, "hooks");
  const selected = spawnSync("git", ["-C", root, "config", "--get", "core.hooksPath"], { encoding: "utf8" });
  if (selected.error || (selected.status !== 0 && selected.status !== 1))
    throw new Error("Cannot inspect Git hooks", { cause: selected.error });
  const current = selected.status === 0 ? selected.stdout.trim() : undefined;
  const originalFile = join(router, "original-path");
  mkdirSync(router, { recursive: true, mode: 0o700 });
  let original: string;
  if (existsSync(originalFile)) {
    original = readFileSync(originalFile, "utf8");
    if (
      current !== router &&
      (current ?? gitBytes(root, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]).toString().trim()) !==
        original
    )
      throw new Error(
        "Git hooks changed after archive protection was installed; reconcile core.hooksPath before continuing",
      );
  } else {
    original =
      current ?? gitBytes(root, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]).toString().trim();
    if (original === router)
      throw new Error(
        "Archive hook routing metadata is missing; preserve the existing hooks and recover it explicitly",
      );
    writeAtomic(originalFile, original, 0o600);
  }
  const protection = repositoryStatePath(root, "archives", "protected", "refs", "heads", branch);
  mkdirSync(dirname(protection), { recursive: true, mode: 0o700 });
  if (!existsSync(protection)) {
    const existing = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      encoding: "utf8",
    });
    if (existing.error || (existing.status !== 0 && existing.status !== 1))
      throw new Error("Cannot capture archive protection baseline");
    writeAtomic(protection, (existing.status === 0 ? existing.stdout.trim() : "new") + "\n", 0o600);
  }
  const previousDirectory = isAbsolute(original) ? original : join(root, original);
  const requiredPush = join(router, "pre-push-required");
  try {
    accessSync(join(previousDirectory, "pre-push"), constants.X_OK);
    writeAtomic(requiredPush, "required\n", 0o600);
  } catch (error) {
    if (!["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  const names = new Set([
    ...hookNames,
    ...(existsSync(previousDirectory) ? readdirSync(previousDirectory).filter((name) => /^[a-z-]+$/.test(name)) : []),
  ]);
  for (const name of names) {
    const prior = isAbsolute(original)
      ? quote(join(original, name))
      : '"$(git rev-parse --show-toplevel)/"' + quote(join(original, name));
    const guard =
      name === "reference-transaction"
        ? `
if [ "$1" = prepared ]; then
  updates=$(cat)
  while read -r old new ref; do
    [ -f ${quote(repositoryStatePath(root, "archives", "protected"))}/"$ref" ] || continue
    permit=${quote(repositoryStatePath(root, "archives", "permits"))}/"$old-$new"
    if [ ! -f "$permit" ] || [ "$(cat "$permit")" != "$ref" ]; then
      printf 'workbench: protected archive branch %s\\n\\nUse workbench record archive for verified transfers.\\n' "$ref" >&2
      exit 1
    fi
  done <<EOF
$updates
EOF
  if [ -x ${prior} ]; then
    printf '%s\\n' "$updates" | ${prior} "$@"
  fi
  exit $?
fi
`
        : "";
    const pushGuard =
      name === "pre-push"
        ? `
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
cat >"$scratch/updates"
node ${quote(join(router, "archive-guard.cjs"))} "$(git rev-parse --show-toplevel)" "$2" "$scratch/updates" "$scratch/project-updates"
if [[ -s "$scratch/project-updates" ]]; then
  if [[ -x ${prior} ]]; then
    WORKBENCH_PUSH_UPDATES="$scratch/updates" ${prior} "$@" <"$scratch/project-updates"
  elif [[ -f ${quote(requiredPush)} ]]; then
    printf 'workbench: project push hook is unavailable.\\n\\nSwitch to a project checkout containing its configured hooks before pushing.\\n' >&2
    exit 1
  fi
fi
exit $?
`
        : "";
    writeAtomic(
      join(router, name),
      `#!/usr/bin/env bash\nset -euo pipefail\n${guard}\n${pushGuard}\nif [ -x ${prior} ]; then exec ${prior} "$@"; fi\n`,
      0o755,
    );
  }
  writeAtomic(
    join(router, "archive-guard.cjs"),
    (descriptor) => {
      copyFileToDescriptor(join(distributionRoot(root), "bundle/archive-guard.cjs"), descriptor);
    },
    0o600,
  );
  gitBytes(root, ["config", "--local", "core.hooksPath", router]);
}

export function allowArchiveAdvance(
  root: string,
  branch: string,
  before: string | undefined,
  after: string,
  restorationBranch?: string,
): void {
  validateBranch(root, branch);
  if (![before ?? after, after].every((value) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)))
    throw new Error("Invalid archive advance");
  const path = repositoryStatePath(root, "archives", "permits", `${before ?? "0".repeat(after.length)}-${after}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeAtomic(path, `refs/heads/${branch}\n`, 0o600);
  if (restorationBranch) {
    validateBranch(root, restorationBranch);
    const witness = repositoryStatePath(root, "archives", "restorations", after);
    mkdirSync(dirname(witness), { recursive: true, mode: 0o700 });
    writeAtomic(witness, `refs/heads/${restorationBranch}\n`, 0o600);
  }
}

/** Explicit acquisition may introduce an independently verified archive into a clone. */
export function acquireArchiveBranch(root: string, branch: string, tip: string): void {
  verifyArchiveHistory(root, tip);
  const ref = `refs/heads/${branch}`;
  const previous = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", ref], { encoding: "utf8" });
  if (previous.error || (previous.status !== 0 && previous.status !== 1))
    throw new Error("Cannot inspect the local archive branch", { cause: previous.error });
  const before = previous.status === 0 ? previous.stdout.trim() : undefined;
  if (before && before !== tip) {
    verifyArchiveHistory(root, before);
    const compatible = spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", before, tip], {
      encoding: "utf8",
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    });
    if (compatible.error || compatible.status !== 0)
      throw new Error(
        "Archive history acquired, but the local archive branch diverges; preserve and reconcile both histories",
      );
  }
  protectArchiveBranch(root, branch);
  if (before !== tip) {
    allowArchiveAdvance(root, branch, before, tip);
    gitBytes(root, ["update-ref", ref, tip, before ?? "0".repeat(tip.length)]);
  }
  writeAtomic(repositoryStatePath(root, "archives", "protected", ref), tip + "\n", 0o600);
}
