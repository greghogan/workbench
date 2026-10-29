import {
  withMaintenanceOperation,
  assertMaintenanceOperation,
  publishDeclarations,
  type MaintenanceOperation,
} from "./operation.mjs";
import { bindPublication, publicationIdentity } from "./publication.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import { manifestMaintenanceEdits } from "./edits.mjs";
import { nativeMaintenanceEdits } from "./native.mjs";
import { MaintenanceSources, metadataRequests } from "./sources.mjs";
import {
  type Release,
  MaintenanceKind,
  MaintenanceProvider,
  MaintenanceState,
  type MaintenanceEntry,
  type MaintenanceTarget,
  type MaintenanceRunner,
} from "./contract.mjs";
import {
  developmentDiscovery,
  maintenanceInputs,
  maintenanceTargets,
  releaseEligible,
  validateMaintenanceRelease,
} from "./plan.mjs";

import { errorFrom, record, records, required, string } from "../values.mjs";

/** Plans name known targets and published versions, never executable instructions or arbitrary write paths. */
export function readMaintenancePlan(root: string, value: unknown) {
  const plan = record(value, "Invalid maintenance plan");
  if (plan.schema_version !== 2) throw new Error("Unsupported maintenance plan version");
  const targets = maintenanceTargets(root);
  const entries = records(plan.entries, "Missing maintenance entries");
  const kinds = new Set(entries.map((entry) => string(entry.kind, "Missing maintenance kind")));
  const expected = targets.filter((target) => kinds.has(target.kind));
  if (entries.length !== expected.length || new Set(entries.map((entry) => entry.id)).size !== entries.length)
    throw new Error("Maintenance target inventory has changed; generate a new plan");
  const selected: { target: MaintenanceTarget; version: string; revision?: string; release: Release }[] = [];
  for (const entry of entries) {
    const target = required(
      expected.find((candidate) => candidate.id === entry.id),
      "Maintenance target inventory has changed; unknown target; generate a new plan",
    );
    for (const [key, field] of Object.entries(target))
      if (!isDeepStrictEqual(entry[key], field)) throw new Error(`Maintenance target has changed: ${target.id}`);
    if (!Object.values(MaintenanceState).some((state) => state === entry.state))
      throw new Error("Invalid maintenance state");
    if (entry.state === MaintenanceState.Available) {
      const release = record(entry.selected, "Missing selected release");
      const revision =
        target.provider === MaintenanceProvider.Tool && target.name === "buildkit"
          ? string(release.revision, "Missing selected BuildKit image digest")
          : undefined;
      if (revision !== undefined && !/^sha256:[a-f0-9]{64}$/.test(revision))
        throw new Error("Invalid selected BuildKit image digest");
      selected.push({
        target,
        version: string(release.version, "Missing selected version"),
        release: {
          version: string(release.version, "Missing selected version"),
          reference: string(release.reference, "Missing release reference"),
          ...(release.integrity !== undefined
            ? { integrity: string(release.integrity, "Invalid release integrity") }
            : {}),
          ...(release.revision !== undefined ? { revision: string(release.revision, "Invalid release revision") } : {}),
          ...(release.assets !== undefined
            ? {
                assets: records(release.assets, "Invalid release assets").map((asset) => {
                  const name = string(asset.name, "Missing asset name");
                  if (asset.url !== undefined)
                    return {
                      name,
                      url: string(asset.url, "Invalid asset URL"),
                      ...(asset.sha256 !== undefined ? { sha256: string(asset.sha256, "Invalid asset digest") } : {}),
                    };
                  return { name, sha256: string(asset.sha256, "Missing release artifact identity") };
                }),
              }
            : {}),
          ...(release.evidence !== undefined
            ? {
                evidence: records(release.evidence, "Invalid release evidence").map((entry) => ({
                  path: string(entry.path, "Missing evidence path"),
                  sha256: string(entry.sha256, "Missing evidence digest"),
                })),
              }
            : {}),
        },
        ...(revision !== undefined ? { revision } : {}),
      });
    }
  }
  const inputs = record(plan.inputs, "Missing plan preconditions");
  const check = (published: Record<string, string> = {}) => {
    if (!isDeepStrictEqual({ ...inputs, ...published }, maintenanceInputs(root, expected)))
      throw new Error("Maintenance inputs have changed; generate a new plan before applying");
  };
  check();
  return { selected, targets: expected, check };
}

async function nixEdits(
  root: string,
  entries: MaintenanceEntry[],
  run: MaintenanceRunner,
  signal?: AbortSignal,
): Promise<[string, string][]> {
  const outputs = new Map<string, Record<string, unknown>>();
  const metadata = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (entry.provider !== MaintenanceProvider.Nix) continue;
    const repository = entry.locator.repository;
    const version = required(entry.selected, "Missing Nix revision").version;
    if (!/^[a-f0-9]{40}$/.test(version)) throw new Error("Invalid Nix revision");
    const reference = `github:${required(repository, "Missing Nix repository")}/${version}`;
    let locked = metadata.get(reference);
    if (!locked) {
      const configuration = parseToml(readFileSync(join(root, "workbench/config.toml"), "utf8"));
      const image = string(
        record(configuration.checks, "Missing check configuration").nix_docker_image,
        "Missing pinned Nix image",
      );
      if (!/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Nix discovery requires an immutable configured image");
      const result = await run({
        command: "docker",
        arguments: [
          "run",
          "--rm",
          "--entrypoint",
          "nix",
          image,
          "--extra-experimental-features",
          "nix-command flakes",
          "flake",
          "metadata",
          "--json",
          reference,
        ],
        cwd: root,
        capture: true,
      });
      signal?.throwIfAborted();
      const published = record(record(JSON.parse(result), "Invalid Nix metadata").locked, "Missing locked Nix source");
      const [owner, name] = required(repository, "Missing Nix repository").split("/");
      if (
        published.rev !== version ||
        published.type !== "github" ||
        published.owner !== owner ||
        published.repo !== name ||
        typeof published.narHash !== "string" ||
        !/^sha256-[A-Za-z0-9+/]{43}=$/.test(published.narHash) ||
        !Number.isSafeInteger(published.lastModified) ||
        Number(published.lastModified) < 0
      )
        throw new Error("Nix metadata does not describe the selected revision");
      // Metadata also contains evaluator-only attributes such as __final. Those are invalid in a flake lock.
      locked = Object.fromEntries(
        ["lastModified", "narHash", "owner", "repo", "rev", "type"].map((key) => [key, published[key]]),
      );
      metadata.set(reference, locked);
    }
    const document =
      outputs.get(entry.path) ?? record(JSON.parse(readFileSync(join(root, entry.path), "utf8")), "Invalid flake lock");
    record(record(document.nodes, "Missing flake nodes")[entry.name], "Missing locked input").locked = locked;
    outputs.set(entry.path, document);
  }
  return [...outputs].map(([path, document]) => [path, `${JSON.stringify(document, null, 2)}\n`]);
}

/** Fetch all replacement metadata and recheck preimages before publishing any declaration. */
export async function applyMaintenance(
  root: string,
  plan: unknown,
  options: {
    sources?: MaintenanceSources;
    discover?: (target: MaintenanceTarget) => Promise<Release[]>;
    run: MaintenanceRunner;
    environments?: boolean;
    signal?: AbortSignal;
    operation?: MaintenanceOperation;
    publish?: (files: [string, string][], check: (published?: Record<string, string>) => void) => void;
  },
): Promise<MaintenanceEntry[]> {
  options.signal?.throwIfAborted();
  if (!options.operation)
    return withMaintenanceOperation(
      root,
      (operation) => applyMaintenance(root, plan, { ...options, operation }),
      options.signal,
    );
  assertMaintenanceOperation(root, options.operation);
  try {
    const prepared = readMaintenancePlan(root, plan);
    if (!options.environments && prepared.selected.some(({ target }) => target.kind === MaintenanceKind.Environments))
      throw new Error("Environment updates require --environments; generate a narrower plan to exclude them");
    const sources = options.sources ?? new MaintenanceSources(metadataRequests(undefined, options.signal));
    const discover = options.discover ?? developmentDiscovery(sources, root);
    const entries: MaintenanceEntry[] = [];
    for (const { target, version, revision, release: planned } of prepared.selected) {
      options.signal?.throwIfAborted();
      const candidate = required(
        (await discover(target)).find((release) => release.version === version),
        `Selected release is no longer published: ${target.name}@${version}`,
      );
      const selected = await bindPublication(
        root,
        target,
        candidate,
        options.sources ?? (options.discover ? undefined : sources),
      );
      options.signal?.throwIfAborted();
      if (target.provider === MaintenanceProvider.Tool && target.name === "buildkit" && selected.revision !== revision)
        throw new Error("The selected BuildKit image digest changed; generate and review a new plan");
      if (!isDeepStrictEqual(publicationIdentity(planned), publicationIdentity(selected)))
        throw new Error(
          `Selected publication identity changed: ${target.name}@${version}; generate and review a new plan`,
        );
      if (!releaseEligible(target, selected))
        throw new Error(
          `Selected release violates the target's support or downgrade constraints: ${target.name}@${version}`,
        );
      await validateMaintenanceRelease(root, target, selected, sources);
      options.signal?.throwIfAborted();
      entries.push({ ...target, state: MaintenanceState.Available, selected });
    }
    const files = [
      ...manifestMaintenanceEdits(
        root,
        entries.filter((entry) => entry.provider !== MaintenanceProvider.Nix),
      ),
      ...(await nativeMaintenanceEdits(root, entries, sources)),
      ...(await nixEdits(root, entries, (command) => options.run(command, options.operation?.owner), options.signal)),
    ];
    options.signal?.throwIfAborted();
    prepared.check();
    options.signal?.throwIfAborted();
    (
      options.publish ??
      ((files, check) => {
        publishDeclarations(root, files, check);
      })
    )(files, prepared.check);
    return entries;
  } catch (error) {
    options.signal?.throwIfAborted();
    throw errorFrom(error);
  }
}
