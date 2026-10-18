import { decisionScopes } from "./decisions.js";
import { required, textLength } from "./invariants.js";
import { existsSync, lstatSync } from "node:fs";
import { extname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Options } from "prettier";
import { parseDocument } from "yaml";
import { kinds, readConfig, readProjects, readText, rootOf, scan, selectProject, writeAtomic } from "./core.js";
import { splitFrontmatter } from "./record-document.js";
import { acquisitionPath } from "./citation-record.js";

function yamlValue(contents: string, path: string): unknown {
  const document = parseDocument(contents);
  if (document.errors.length)
    throw new Error(`${path}: invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`);
  return document.toJS();
}

/** The bundled plugins require no formatter installation in a consuming project. */
export async function formatDocument(contents: string, path: string, width: number): Promise<string> {
  const extension = extname(path).toLowerCase();
  const parser =
    extension === ".md"
      ? "markdown"
      : extension === ".json"
        ? "json"
        : [".yaml", ".yml"].includes(extension)
          ? "yaml"
          : undefined;
  if (!parser) throw new Error(`${path}: supported formats are Markdown (.md), JSON (.json), and YAML (.yaml or .yml)`);
  const jsonValue: unknown = parser === "json" ? JSON.parse(contents) : undefined;
  // Keep the formatter bundled and offline, but initialize it only for formatting work.
  const [{ format }, markdownPlugin, yamlPlugin, babelPlugin, estreePlugin] = await Promise.all([
    import("prettier/standalone"),
    import("prettier/plugins/markdown"),
    import("prettier/plugins/yaml"),
    import("prettier/plugins/babel"),
    import("prettier/plugins/estree"),
  ]);
  const options: Options = {
    plugins: [markdownPlugin, yamlPlugin, babelPlugin, estreePlugin],
    printWidth: width,
    proseWrap: "always",
    embeddedLanguageFormatting: "off",
    endOfLine: "lf",
    tabWidth: 2,
    useTabs: false,
  };
  const frontmatter = parser === "markdown" ? splitFrontmatter(contents) : undefined;
  // Disabling embedded code formatting also disables frontmatter formatting in Markdown.
  // Format its YAML explicitly so metadata is canonical while fenced evidence stays untouched.
  const input = frontmatter
    ? `---\n${await format(frontmatter.yaml, { ...options, parser: "yaml" })}---\n\n${frontmatter.body}`
    : contents;
  const formatted = await format(input, { ...options, parser });
  // YAML reflow must preserve scalar values, types, and sequence order, including in frontmatter.
  if (parser === "yaml" && !isDeepStrictEqual(yamlValue(contents, path), yamlValue(formatted, path)))
    throw new Error(`${path}: formatting would change YAML values`);
  if (parser === "json" && !isDeepStrictEqual(jsonValue, JSON.parse(formatted)))
    throw new Error(`${path}: formatting would change JSON values`);
  if (frontmatter) {
    const result = splitFrontmatter(formatted);
    if (!result || !isDeepStrictEqual(yamlValue(frontmatter.yaml, path), yamlValue(result.yaml, path)))
      throw new Error(`${path}: formatting would change frontmatter values`);
  }
  return formatted;
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
