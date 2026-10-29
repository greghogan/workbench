import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// High-confidence credential formats only. Diagnostics never include the matching value.
const credentials = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{36}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{82}\b/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bsk_live_[A-Za-z0-9]{24,}\b/,
  /\bxox[baprs]-[0-9]{10,}-[A-Za-z0-9-]{10,}\b/,
];
const generated = new Set([
  ".git",
  ".workbench",
  "node_modules",
  "vendor",
  ".bundle",
  ".venv",
  ".pnpm-store",
  "target",
  "build",
  "dist",
  "coverage",
]);

export function checkSecrets(root: string): void {
  const found: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!generated.has(entry.name)) walk(path);
      } else if (entry.isFile()) {
        const content = readFileSync(path);
        if (content.includes(0)) continue;
        for (const [index, line] of content.toString("utf8").split(/\r?\n/).entries())
          if (credentials.some((pattern) => pattern.test(line)))
            found.push(`${relative(root, path)}:${String(index + 1)}`);
      }
    }
  }
  walk(root);
  if (found.length) throw new Error(`possible credentials at ${found.join(", ")}; remove them before commit`);
  console.log("No recognized private keys or service credentials in project source files.");
}
