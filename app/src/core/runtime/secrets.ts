import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { mapFileIO } from "./file-reads.js";

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

export async function checkSecrets(root: string): Promise<void> {
  const files: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!generated.has(entry.name)) walk(path);
      } else if (entry.isFile()) files.push(path);
    }
  }
  walk(root);
  const matches = await mapFileIO(
    files,
    async (path) => {
      const content = await readFile(path);
      if (content.includes(0)) return [];
      const text = content.toString("utf8");
      if (!credentials.some((pattern) => pattern.test(text))) return [];
      return text
        .split(/\r?\n/)
        .flatMap((line, index) =>
          credentials.some((pattern) => pattern.test(line)) ? [`${relative(root, path)}:${String(index + 1)}`] : [],
        );
    },
    8,
  );
  const found = matches.flat();
  if (found.length) throw new Error(`possible credentials at ${found.join(", ")}; remove them before commit`);
  console.log("No recognized private keys or service credentials in project source files.");
}
