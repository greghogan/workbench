import { spawnSync } from "node:child_process";
import { textLength } from "./invariants.js";
import { readConfig, readText } from "./core.js";
import { commitPrefixPattern, type CommitStyle } from "./config-schema.js";

const conventionalTypes = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];

export function validateCommitPolicy(root: string): {
  style: CommitStyle;
  subjectWidth: number;
  bodyWidth: number;
  prefixes: string[] | undefined;
} {
  const config = readConfig(root) as {
    commit?: { style?: CommitStyle; prefixes?: string[]; subject_width?: number; body_width?: number };
  };
  // Configuration reads and edits share the schema; resolve defaults only here.
  const style = config.commit?.style ?? "conventional";
  const subjectWidth = config.commit?.subject_width ?? 50;
  const bodyWidth = config.commit?.body_width ?? 72;
  const prefixes = config.commit?.prefixes ?? (style === "conventional" ? [...conventionalTypes] : undefined);
  return { style, subjectWidth, bodyWidth, prefixes };
}

export function checkCommit(root: string, messagePath: string): void {
  const policy = validateCommitPolicy(root);
  if (policy.style === "unrestricted") return;
  const setting = (key: string) => {
    const result = spawnSync("git", ["-C", root, "config", "--get", key], { encoding: "utf8" });
    if (result.error || (result.status !== 0 && result.status !== 1))
      throw new Error(`cannot read Git message settings: ${String(result.stderr || result.error)}`);
    return result.stdout.trim();
  };
  const comment = setting("core.commentString") || setting("core.commentChar") || "#";
  const lines = readText(messagePath).split(/\r?\n/);
  const cut = lines.findIndex((line) => line === `${comment} ------------------------ >8 ------------------------`);
  if (cut >= 0) lines.splice(cut);
  const content = lines.filter((line) => !line.startsWith(comment));
  while (content[0] === "") content.shift();
  const subject = content[0] ?? "";
  if (["Merge ", "Revert ", "fixup!", "squash!"].some((prefix) => subject.startsWith(prefix))) return;
  if (textLength(subject) > policy.subjectWidth)
    throw new Error(`change subject is longer than ${String(policy.subjectWidth)} characters`);
  if (content[1] && content[1] !== "") throw new Error("change subject and body must be separated by a blank line");
  for (const [index, line] of lines.entries()) {
    if (index > 0 && !line.startsWith(comment) && textLength(line) > policy.bodyWidth) {
      throw new Error(
        `change message line ${String(index + 1)} is ${String(textLength(line))} characters (maximum ${String(policy.bodyWidth)})`,
      );
    }
  }
  if (policy.style === "plain") {
    if (!/^\S(?:.*\S)?$/.test(subject))
      throw new Error("change subject must be nonempty text without surrounding whitespace");
    return;
  }
  const match =
    policy.style === "conventional"
      ? /^([^:()!\s]+)(?:\(([a-z][a-z0-9._/-]*)\))?!?: (\S(?:.*\S)?)$/.exec(subject)
      : /^([^:]+): (\S(?:.*\S)?)$/.exec(subject);
  const prefix = match?.[1];
  if (!prefix || !commitPrefixPattern.test(prefix))
    throw new Error(
      policy.style === "conventional"
        ? "change subject must use 'type(optional-scope): concise description' Conventional Commit form"
        : "change subject must use 'area: concise description' form",
    );
  if (policy.prefixes && !policy.prefixes.some((allowed) => allowed.toLowerCase() === prefix.toLowerCase()))
    throw new Error(
      `change ${policy.style === "conventional" ? "type" : "area"} '${prefix}' must be one of: ${policy.prefixes.join(", ")}`,
    );
}
