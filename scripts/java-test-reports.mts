import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { publishDirectory } from "./directory-publication.mjs";
import { readBoundedFile } from "../src/file-reads.js";
import { SaxesParser } from "saxes";
export interface JavaModuleReports {
  id: string;
  path: string;
  reports: string;
}
export interface JavaTestRun {
  role: string;
  startedAt: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
  tests?: string;
  context?: {
    toolchain: { java?: string; tools?: string };
    modules: { path: string; inputsSha256: string }[];
  };
}

/** Retain one complete report set; a failed or missing run never borrows evidence from its predecessor. */
export function retainJavaTestReports(
  reports: string,
  root: string,
  run: JavaTestRun,
  modules: readonly JavaModuleReports[] = [],
): string[] {
  const coverage = join(root, "coverage"),
    destination = join(coverage, run.role === "diagnostic" ? "java-diagnostic" : "surefire");
  for (const path of [coverage, destination])
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`Java test reports must not traverse a symbolic link: ${path}`);
  mkdirSync(coverage, { recursive: true });
  const transaction = mkdtempSync(join(coverage, ".surefire-"));
  const incoming = join(transaction, "incoming"),
    previous = join(transaction, "previous");
  let published = false;
  const failures: string[] = [];
  try {
    mkdirSync(incoming);
    const copyReports = (source: string, destination: string) => {
      if (!existsSync(source)) return false;
      if (lstatSync(source).isSymbolicLink()) throw new Error("Java test reports must not be symbolic links");
      for (const entry of readdirSync(source, { recursive: true, withFileTypes: true }))
        if (entry.isSymbolicLink()) throw new Error("Java test reports must not contain symbolic links");
      cpSync(source, destination, { recursive: true });
      return readdirSync(destination).some((name) => name.endsWith(".xml"));
    };
    let hasReports = copyReports(reports, incoming);
    const identities = new Set<string>();
    const retainedModules = modules.map((module) => {
      if (!/^[A-Za-z0-9_+.-]+$/.test(module.id) || [".", ".."].includes(module.id) || identities.has(module.id))
        throw new Error("Invalid or repeated Java report module identity");
      identities.add(module.id);
      const destination = module.reports === reports ? incoming : join(incoming, "modules", module.id);
      const available = module.reports === reports ? hasReports : copyReports(module.reports, destination);
      hasReports ||= available;
      if (available) failures.push(...javaTestFailures(destination, module.path));
      return { id: module.id, path: module.path, available };
    });
    if (!modules.length && hasReports) failures.push(...javaTestFailures(incoming, "."));
    writeFileSync(
      join(incoming, ".workbench-run.json"),
      JSON.stringify(
        {
          schema: 1,
          runId: randomUUID(),
          ...run,
          ...(modules.length ? { modules: retainedModules } : {}),
          finishedAt: new Date().toISOString(),
          outcome: !hasReports ? "missing" : run.status === 0 && !run.signal && !run.error ? "passed" : "failed",
        },
        null,
        2,
      ) + "\n",
    );
    publishDirectory(incoming, destination, previous);
    published = true;
    return failures;
  } finally {
    if (published || !existsSync(previous)) rmSync(transaction, { recursive: true, force: true });
  }
}

/** Bound terminal diagnostics while retaining the complete original reports for investigation. */
function javaTestFailures(reports: string, module: string): string[] {
  const failures: string[] = [];
  for (const file of readdirSync(reports)
    .filter((name) => name.endsWith(".xml"))
    .sort()) {
    if (failures.length >= 8) break;
    try {
      const parser = new SaxesParser();
      let test = "",
        cause = "",
        failed = false;
      parser.on("doctype", () => {
        throw new Error("test reports cannot contain document types");
      });
      parser.on("opentag", (tag) => {
        if (tag.name === "testcase") test = [tag.attributes.classname, tag.attributes.name].filter(Boolean).join("#");
        if (tag.name === "failure" || tag.name === "error") {
          failed = true;
          cause = tag.attributes.message ?? tag.attributes.type ?? "";
        }
      });
      parser.on("text", (text) => {
        if (failed && cause.length < 512) cause += " " + text.slice(0, 512 - cause.length);
      });
      parser.on("closetag", (tag) => {
        if (tag.name === "failure" || tag.name === "error") {
          if (failures.length < 8)
            failures.push(`${module}: ${test || file}: ${cause.replace(/\s+/g, " ").trim().slice(0, 512)}`);
          failed = false;
        }
      });
      parser.write(readBoundedFile(join(reports, file), 2 * 1024 * 1024, "Java test report").toString("utf8")).close();
    } catch {
      failures.push(`${module}: cannot summarize ${file}; inspect the retained report`);
    }
  }
  return failures;
}
