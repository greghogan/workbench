import { decisionScopes } from "./decisions.js";
import { required, textLength } from "./invariants.js";
import { existsSync, lstatSync } from "node:fs";
import { kinds } from "./record-identity.js";
import { readConfig, readProjects, selectProject } from "./project-configuration.js";
import { readText } from "./files.js";
import { rootOf } from "./project-context.js";
import { scan } from "./record-files.js";
import { writeAtomic } from "../scripts/file-publication.mjs";
import { acquisitionPath } from "./citation-record.js";

/** Formatting dependencies load only when a formatting operation requests them. */
export async function formatDocument(contents: string, path: string, width: number): Promise<string> {
  const formatter = await import("./formatter.js");
  return formatter.formatDocument(contents, path, width);
}

export function recordPaths(root: string, projectId?: string): string[] {
  const projects = projectId ? [selectProject(root, projectId)] : readProjects(root);
  return [
    ...decisionScopes(root, false)
      .filter((scope) => scope.source && (!projectId || scope.appliesTo.includes(projects[0]?.path ?? ".")))
      .flatMap((scope) => scope.decisions.map((decision) => decision.path)),
    ...projects.flatMap((project) =>
      kinds.flatMap((kind) =>
        scan(rootOf(root, project), kind).flatMap((record) =>
          kind === "CIT" && existsSync(acquisitionPath(record.path))
            ? [record.path, acquisitionPath(record.path)]
            : [record.path],
        ),
      ),
    ),
  ];
}

export async function formattingErrors(paths: string[], width: number): Promise<string[]> {
  const errors: string[] = [];
  for (const path of paths) {
    try {
      const original = readText(path);
      if (original !== (await formatDocument(original, path, width)))
        errors.push(`${path}: formatting differs; run 'workbench format PATH --write'`);
    } catch (error) {
      errors.push(String(error));
    }
  }
  return errors;
}

export async function formatFiles(
  root: string,
  requested: string | undefined,
  options: { all?: boolean; project?: string; write?: boolean; check?: boolean },
): Promise<void> {
  if (!!requested === !!options.all) throw new Error("supply a file path or --all");
  if (options.project && !options.all) throw new Error("--project requires --all");
  if (options.all && !options.write && !options.check) throw new Error("--all requires --write or --check");
  const paths = requested ? [requested] : recordPaths(root, options.project);
  const width = required(
    required(readConfig(root).markdown, "expected readConfig(root).markdown").wrap_width,
    "expected readConfig(root).markdown!.wrap_width",
  );
  // Parse the whole batch before publishing any changes, so malformed input cannot cause a partial format.
  const files: { path: string; original: string; formatted: string }[] = [];
  for (const path of paths) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${path}: expected a regular file`);
    const original = readText(path);
    files.push({ path, original, formatted: await formatDocument(original, path, width) });
  }
  const changed = files.filter((file) => file.original !== file.formatted);
  if (options.check) {
    if (changed.length)
      throw new Error(
        `${changed.map((file) => file.path).join("\n")}: formatting differs; run the same command with --write`,
      );
    console.log(`Formatting is current (${String(files.length)} file(s)).`);
  } else if (options.write) {
    for (const file of changed) {
      if (readText(file.path) !== file.original) throw new Error(`${file.path}: changed while formatting; retry`);
      writeAtomic(file.path, file.formatted);
      console.log(`Formatted ${file.path}`);
    }
    if (!changed.length) console.log("Formatting is already current.");
  } else process.stdout.write(required(files[0], "expected files[0]").formatted);
}

export function wrap(value: string, width: number, indentation = 0): string {
  let output = "";
  let length = indentation;
  for (const word of value.trim().split(/\s+/)) {
    if (output && length + 1 + textLength(word) > width) {
      output += `\n${" ".repeat(indentation)}${word}`;
      length = indentation + textLength(word);
    } else {
      if (output) {
        output += " ";
        length++;
      }
      output += word;
      length += textLength(word);
    }
  }
  return output;
}
