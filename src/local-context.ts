import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../scripts/file-publication.mjs";
import { globalCollectionDirectories, inspectCollection, registryPins } from "./collections.js";
import { collectionDecisionScopes } from "./decisions.js";
import { renderScopeContext } from "./agents.js";
import { ownedPath } from "./paths.js";
import { userDirectory } from "./storage.js";

export function installedContext(base: string): string {
  const collections = registryPins(base).map((pin) => ({
    ...inspectCollection(ownedPath(base, `${pin.id}/${pin.revision}`), pin),
    pin,
    local: true as const,
  }));
  return renderScopeContext(base, collectionDecisionScopes(collections), 120, true, false);
}

/** Each installation owns its context; system changes do not require rewriting every user's file. */
export function syncLocalContext(base: string): string {
  const path = ownedPath(base, "AGENTS.md");
  writeAtomic(path, installedContext(base));
  if (process.platform !== "win32")
    chmodSync(path, registryPins(base).every((pin) => pin.visibility === "public") ? 0o644 : 0o600);
  syncLocalContextIndex();
  return path;
}

export function syncLocalContextIndex(): string {
  const data = userDirectory("data");
  const base = join(data, "collections");
  const own = ownedPath(base, "AGENTS.md");
  writeAtomic(own, installedContext(base));
  if (process.platform !== "win32") chmodSync(own, 0o600);
  const path = ownedPath(data, "AGENTS.md");
  const sources = globalCollectionDirectories().map(
    (directory) =>
      `- [Local collection context](${join(directory, "AGENTS.md").replaceAll("\\", "/").replaceAll(" ", "%20")}) (read when present).`,
  );
  writeAtomic(
    path,
    `Read the applicable local contexts and their decision maps:\n\n${sources.join("\n")}\n\nAlso read \`workbench/.local-collections/AGENTS.md\` in the current checkout when present.\n\nObtain human approval before activating local policy changes. Before project work, run\n\`workbench collection compatibility check\`; review changed policies before acknowledgment and refer conflicts to the human.\n`,
  );
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return path;
}

export function localContextFresh(base: string): boolean {
  const path = ownedPath(base, "AGENTS.md");
  return existsSync(path) && readFileSync(path, "utf8") === installedContext(base);
}
