import { spawnSync } from "node:child_process";
import { textLength } from "./invariants.js";
import { readConfig } from "./project-configuration.js";
import { readFilePrefix } from "./file-reads.js";
import { InvalidInput } from "./input-errors.js";
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

export const commitMessageLimit = 1024 * 1024;

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
  const style = config.commit?.style ?? "unrestricted";
  const subjectWidth = config.commit?.subject_width ?? 50;
  const bodyWidth = config.commit?.body_width ?? 72;
  const prefixes = config.commit?.prefixes ?? (style === "conventional" ? [...conventionalTypes] : undefined);
  return { style, subjectWidth, bodyWidth, prefixes };
}

export function readCommitMessage(root: string, messagePath: string): string {
  const setting = (key: string) => {
    const result = spawnSync("git", ["-C", root, "config", "--get", key], { encoding: "utf8" });
    if (result.error || (result.status !== 0 && result.status !== 1))
      throw new Error(`cannot read Git message settings: ${String(result.stderr || result.error)}`);
    return result.stdout.trim();
  };
  const comment = setting("core.commentString") || setting("core.commentChar") || "#";
  const scissors = `${comment} ------------------------ >8 ------------------------`;
  const marker = Buffer.from(scissors);
  const prefix = readFilePrefix(messagePath, commitMessageLimit + marker.length + 2, (bytes) => {
    for (let index = bytes.indexOf(marker); index >= 0; index = bytes.indexOf(marker, index + 1)) {
      const next = index + marker.length;
      if (
        (index === 0 || bytes[index - 1] === 10) &&
        (bytes[next] === 10 || (bytes[next] === 13 && bytes[next + 1] === 10))
      )
        return index;
    }
    return undefined;
  });
  const end = prefix.length - marker.length;
  const contents =
    end >= 0 && prefix.subarray(end).equals(marker) && (end === 0 || prefix[end - 1] === 10)
      ? prefix.subarray(0, end)
      : prefix;
  if (contents.length > commitMessageLimit)
    throw new InvalidInput("Commit message before Git's diff must be at most 1 MiB");
  return contents
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(comment))
    .join("\n");
}

export function checkCommit(root: string, messagePath: string): string {
  const policy = validateCommitPolicy(root);
  const message = readCommitMessage(root, messagePath);
  if (policy.style === "unrestricted") return message;
  const content = message.split(/\r?\n/);
  while (content[0] === "") content.shift();
  const subject = content[0] ?? "";
  if (["Merge ", "Revert ", "fixup!", "squash!"].some((prefix) => subject.startsWith(prefix))) return message;
  if (textLength(subject) > policy.subjectWidth)
    throw new Error(`change subject is longer than ${String(policy.subjectWidth)} characters`);
  if (content[1] && content[1] !== "") throw new Error("change subject and body must be separated by a blank line");
  for (const [index, line] of content.entries()) {
    if (index > 0 && textLength(line) > policy.bodyWidth) {
      throw new Error(
        `change message line ${String(index + 1)} is ${String(textLength(line))} characters (maximum ${String(policy.bodyWidth)})`,
      );
    }
  }
  if (policy.style === "plain") {
    if (!/^\S(?:.*\S)?$/.test(subject))
      throw new Error("change subject must be nonempty text without surrounding whitespace");
    return message;
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
  return message;
}
