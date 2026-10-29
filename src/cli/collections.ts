import { Option, type Command } from "commander";
import { join, resolve } from "node:path";
import { renderAgentContext } from "../agents.js";
import { registerCommand } from "./commands.js";
import { fetchCollectionOriginals, stageCollectionSubmodules, type GitCollectionOptions } from "../collection-git.js";
import { installSelectedCollections } from "../collection-install.js";
import { collectionChanges, reconcileCollection } from "../collection-reconcile.js";
import { inspectCollection, listCollections } from "../collections.js";
import { registerLocalPolicyCommands } from "./local-policy.js";
import { policyCompatibility } from "../policy-compatibility.js";
import { readConfig } from "../project-configuration.js";
import { userDirectory } from "../storage.js";

import {
  checkCollectionExport,
  compareCollection,
  exportCollection,
  prepareCollectionReview,
} from "../collection-service.js";

async function collectionApplied(root: string, ids: string[]): Promise<void> {
  const preparation = await prepareCollectionReview(root);
  console.error("Collection files applied; review adopted records with workbench review.");
  for (const issue of preparation.issues) console.error(issue);
  if (preparation.omitted) console.error(`${String(preparation.omitted)} additional validation issues omitted.`);
  for (const id of ids) console.error(`Stage the collection reference explicitly: workbench collection stage ${id}`);
}

export function registerCollectionCommands(program: Command, root: string): void {
  const collection = registerCommand(program, "collection")
    .description("Inspect project-owned collections and local policy")
    .option("--installed", "List all stored revisions, including older unselected revisions")
    .option("--json", "Print identities, pins, scopes, and locations as JSON")
    .action((options: { installed?: boolean; json?: boolean }) => {
      listCollections(root, !!options.installed, !!options.json);
    });
  collection
    .command("changes")
    .description("List project adaptations against the retained upstream snapshot")
    .argument("<id>")
    .action((id: string) => {
      console.log(JSON.stringify(collectionChanges(root, id), null, 2));
    });
  collection
    .command("fetch")
    .description("Fetch the pinned original Git objects without checking out collection files")
    .argument("<id>")
    .action((id: string) => {
      const pin = readConfig(root).collections?.sources?.find((entry) => entry.id === id);
      if (!pin) throw new Error(`project collection not found: ${id}`);
      fetchCollectionOriginals(root, pin);
      console.log(`Originals available for ${id} at ${pin.commit ?? ""}; no working tree was created.`);
    });
  collection
    .command("stage")
    .description("Explicitly stage collection gitlinks; other files remain for ordinary git add")
    .argument("[id]")
    .action((id?: string) => {
      const pins = (readConfig(root).collections?.sources ?? []).filter((pin) => !id || pin.id === id);
      if (!pins.length) throw new Error("no matching project collections");
      stageCollectionSubmodules(root, pins);
      console.log(
        `Staged ${String(pins.length)} collection gitlink(s). Stage .gitmodules, configuration, and reviewed records separately.`,
      );
    });
  collection
    .command("update")
    .description("Reconcile a pinned Git collection with project adaptations")
    .argument("<id>")
    .argument("[repository]")
    .requiredOption("--commit <commit>", "Full immutable source Git commit")
    .option("--collection <path>", "Collection root within the source repository")
    .option("--sha256 <digest>", "Additionally verify the expected collection content digest")
    .option("--resolved <directory>", "Complete manually reconciled proposal after conflicts")
    .action(
      async (id: string, repository: string | undefined, options: GitCollectionOptions & { resolved?: string }) => {
        const pin = readConfig(root).collections?.sources?.find((entry) => entry.id === id);
        if (!pin?.source) throw new Error(`project collection not found: ${id}`);
        console.log(
          JSON.stringify(
            reconcileCollection(
              root,
              repository ?? pin.source,
              { ...options, collection: options.collection ?? pin.collection ?? ".", visibility: pin.visibility },
              id,
              options.resolved,
            ),
            null,
            2,
          ),
        );
        await collectionApplied(root, [id]);
      },
    );
  registerLocalPolicyCommands(collection, root);
  collection
    .command("context")
    .description("Read current local guidance, context locations, and compatibility review status")
    .action(() => {
      process.stdout.write(renderAgentContext(root, true));
      console.log(`\nLocal context entry point: ${join(userDirectory("data"), "AGENTS.md")}`);
      console.log(JSON.stringify(policyCompatibility(root), null, 2));
    });
  collection
    .command("inspect")
    .description("Verify a locally acquired collection and print its pin")
    .argument("<directory>")
    .action((directory: string) => {
      const { pin } = inspectCollection(resolve(directory));
      console.log(JSON.stringify(pin, null, 2));
    });
  collection
    .command("install")
    .description("Adopt a project collection or prepare a local draft for human approval")
    .argument("<directories...>", "One Git repository for project adoption, or local exports for machine guidance")
    .option("--resolved <directory>", "Resolved local update proposal")
    .option("--commit <commit>", "Full source Git commit for project adoption")
    .option("--collection <path>", "Collection root within the source repository", ".")
    .addOption(new Option("--visibility <visibility>").choices(["public", "private"]).default("private"))
    .option(
      "--sha256 <digest>",
      "Recorded manifest digest; repeat in the same order as directories",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .addOption(
      new Option("--scope <scope>", "Installation scope; project is tracked, local is checkout-only")
        .choices(["user", "system", "local", "project"])
        .default("project"),
    )
    .option(
      "--directory <directory>",
      "Override the destination collections directory, including a system installation",
    )
    .action(
      async (
        directories: string[],
        options: {
          sha256: string[];
          directory?: string;
          scope: string;
          commit?: string;
          collection?: string;
          visibility: "public" | "private";
          resolved?: string;
        },
      ) => {
        if ((options.scope !== "project" || options.sha256.length) && directories.length !== options.sha256.length)
          throw new Error("supply one --sha256 for each directory, in the same order");
        if (options.scope === "project" && options.resolved)
          throw new Error("use collection update --resolved for project reconciliation");
        const pins = installSelectedCollections(
          root,
          directories.map((source, index) => ({
            source,
            ...(options.sha256[index] ? { sha256: options.sha256[index] } : {}),
          })),
          options,
        );
        const selections = pins.map((pin) => ({
          ...pin,
          installation: options.scope === "project" ? "project" : "pending-local",
        }));
        console.log(JSON.stringify(selections.length === 1 ? selections[0] : selections, null, 2));
        if (options.scope === "project")
          await collectionApplied(
            root,
            pins.map((pin) => pin.id),
          );
      },
    );
  collection
    .command("export")
    .description("Export explicitly selected project ADRs for consumers")
    .argument("<directory>")
    .requiredOption("--id <id>")
    .requiredOption("--revision <revision>")
    .option("--project <id>")
    .option(
      "--charter <path>",
      "Human-written collection charter; defaults to the selected project's workbench/CHARTER.md",
    )
    .option(
      "--decision <id>",
      "Export this ADR; repeat to select several",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--all", "Explicitly export all decisions in the selected project")
    .addOption(new Option("--visibility <visibility>").choices(["public", "private"]).default("private"))
    .action(
      async (
        directory: string,
        options: {
          id: string;
          revision: string;
          project?: string;
          charter?: string;
          decision: string[];
          all?: boolean;
          visibility: "public" | "private";
        },
      ) => {
        console.log(
          JSON.stringify(
            await exportCollection(
              root,
              directory,
              options.id,
              options.revision,
              options.decision,
              options.project,
              !!options.all,
              options.visibility,
              options.charter,
            ),
            null,
            2,
          ),
        );
      },
    );
  collection
    .command("compare")
    .description("Report upstream changes from an exact Git commit without updating policy")
    .argument("<id>")
    .argument("[repository]")
    .requiredOption("--commit <commit>")
    .option("--collection <path>")
    .option("--sha256 <digest>")
    .option("--include-private", "Show private policy only to a private audience")
    .action(
      (id: string, repository: string | undefined, options: GitCollectionOptions & { includePrivate?: boolean }) => {
        const pin = readConfig(root).collections?.sources?.find((entry) => entry.id === id);
        if (!pin?.source) throw new Error(`project collection not found: ${id}`);
        console.log(
          JSON.stringify(
            compareCollection(
              root,
              id,
              repository ?? pin.source,
              { ...options, collection: options.collection ?? pin.collection ?? ".", visibility: pin.visibility },
              !!options.includePrivate,
            ),
            null,
            2,
          ),
        );
      },
    );
  collection
    .command("check-export")
    .description("Verify collection references and the permitted export audience")
    .option("--include-private", "Export into a private audience; does not authorize public publication")
    .action((options: { includePrivate?: boolean }) => {
      checkCollectionExport(root, !!options.includePrivate);
      console.log("Collection export audience and references verified.");
    });
}
