import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { record, string } from "./values.mjs";

export const ciActionManifest = "scripts/ci-actions.json";
export interface CIActionPin {
  version: string;
  revision: string;
}
export function readCIActionPins(source: string): Record<string, CIActionPin> {
  return Object.fromEntries(
    Object.entries(record(JSON.parse(source), "Invalid CI action manifest")).map(([name, value]) => {
      const pin = record(value, "Invalid CI action pin");
      const version = string(pin.version, "Missing CI action version"),
        revision = string(pin.revision, "Missing CI action revision");
      if (
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) ||
        !/^\d+\.\d+\.\d+$/.test(version) ||
        !/^[a-f0-9]{40}$/.test(revision) ||
        Object.keys(pin).some((key) => !["version", "revision"].includes(key))
      )
        throw new Error("CI actions require versioned immutable pins");
      return [name, { version, revision }];
    }),
  );
}
export function ciActionPins(root: string): Record<string, CIActionPin> {
  const path = join(root, ciActionManifest);
  return existsSync(path) ? readCIActionPins(readFileSync(path, "utf8")) : {};
}
export function workflowPaths(root: string): string[] {
  const result: string[] = [];
  const visit = (path: string, nested: boolean) => {
    if (!existsSync(join(root, path))) return;
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const name = `${path}/${entry.name}`;
      if (entry.isDirectory() && nested) visit(name, true);
      else if (entry.isFile() && (nested ? /^action\.ya?ml$/.test(entry.name) : /\.ya?ml$/.test(entry.name)))
        result.push(name);
    }
  };
  visit(".github/workflows", false);
  visit(".github/actions", true);
  return result.sort();
}
