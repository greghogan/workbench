import { textLength } from "./invariants.js";
import { readConfig, readText } from "./core.js";

export function validateCommitPolicy(root: string): {
  style: "conventional" | "unrestricted";
  subjectWidth: number;
  bodyWidth: number;
} {
  const config = readConfig(root) as { commit?: { style?: string; subject_width?: number; body_width?: number } };
  const style = config.commit?.style ?? "conventional";
  if (style !== "conventional" && style !== "unrestricted")
    throw new Error("commit.style must be conventional or unrestricted");
  const subjectWidth = config.commit?.subject_width ?? 50;
  const bodyWidth = config.commit?.body_width ?? 72;
  if (![subjectWidth, bodyWidth].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("commit widths must be positive integers");
  }
  return { style, subjectWidth, bodyWidth };
}

export function checkCommit(root: string, messagePath: string): void {
  const policy = validateCommitPolicy(root);
  if (policy.style === "unrestricted") return;
  const lines = readText(messagePath).split(/\r?\n/);
  const subject = lines[0] ?? "";
  if (["Merge ", "Revert ", "fixup!", "squash!"].some((prefix) => subject.startsWith(prefix))) return;
  if (textLength(subject) > policy.subjectWidth)
    throw new Error(`change subject is longer than ${String(policy.subjectWidth)} characters`);
  if (lines[1] && lines[1] !== "") throw new Error("change subject and body must be separated by a blank line");
  for (const [index, line] of lines.entries()) {
    if (index > 0 && !line.startsWith("#") && textLength(line) > policy.bodyWidth) {
      throw new Error(
        `change message line ${String(index + 1)} is ${String(textLength(line))} characters (maximum ${String(policy.bodyWidth)})`,
      );
    }
  }
  const match =
    /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\(([a-z][a-z0-9._/-]*)\))?!?: (\S(?:.*\S)?)$/.exec(
      subject,
    );
  if (!match)
    throw new Error("change subject must use 'type(optional-scope): concise description' Conventional Commit form");
}
