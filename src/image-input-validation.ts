import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { managedDeclaration } from "../scripts/managed-source-contract.mjs";
import { readConfig, readLanguageRoots } from "./core.js";

/** Existing declarations own source membership; image configuration remains explicitly project-owned. */
export function validateManagedImageInputs(root: string): void {
  const roots = readLanguageRoots(root);
  for (const profile of readConfig(root).development?.profiles ?? []) {
    if (!profile.offline || profile.builder === "native") continue;
    for (const entry of roots) {
      if (profile.offline.paths && !profile.offline.paths.includes(entry.path)) continue;
      const file = posix.join(entry.path, "managed-check-inputs.json");
      if (!existsSync(join(root, file))) continue;
      const declaration = managedDeclaration(JSON.parse(readFileSync(join(root, file), "utf8")));
      for (const input of [file, ...Object.keys(declaration.source_hashes).map((name) => posix.join(entry.path, name))])
        if (!profile.offline.inputs.some((selected) => selected === input || input.startsWith(`${selected}/`)))
          throw new Error(`${profile.name}: offline.inputs omits declared dependency input ${input}`);
    }
  }
}
