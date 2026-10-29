import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { publishDirectory } from "./directory-publication.mjs";
export interface JavaTestRun {
  role: string;
  startedAt: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

/** Retain one complete report set; a failed or missing run never borrows evidence from its predecessor. */
export function retainJavaTestReports(reports: string, root: string, run: JavaTestRun): void {
  const coverage = join(root, "coverage"),
    destination = join(coverage, "surefire");
  for (const path of [coverage, destination])
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`Java test reports must not traverse a symbolic link: ${path}`);
  mkdirSync(coverage, { recursive: true });
  const transaction = mkdtempSync(join(coverage, ".surefire-"));
  const incoming = join(transaction, "incoming"),
    previous = join(transaction, "previous");
  let published = false;
  try {
    mkdirSync(incoming);
    if (existsSync(reports)) {
      if (lstatSync(reports).isSymbolicLink()) throw new Error("Java test reports must not be symbolic links");
      for (const entry of readdirSync(reports, { recursive: true, withFileTypes: true }))
        if (entry.isSymbolicLink()) throw new Error("Java test reports must not contain symbolic links");
      cpSync(reports, incoming, { recursive: true });
    }
    const hasReports = readdirSync(incoming).some((name) => name.endsWith(".xml"));
    writeFileSync(
      join(incoming, ".workbench-run.json"),
      JSON.stringify(
        {
          schema: 1,
          runId: randomUUID(),
          ...run,
          finishedAt: new Date().toISOString(),
          outcome: !hasReports ? "missing" : run.status === 0 && !run.signal && !run.error ? "passed" : "failed",
        },
        null,
        2,
      ) + "\n",
    );
    publishDirectory(incoming, destination, previous);
    published = true;
  } finally {
    if (published || !existsSync(previous)) rmSync(transaction, { recursive: true, force: true });
  }
}
