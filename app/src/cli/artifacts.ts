import type { Command } from "commander";
import {
  artifactHost,
  artifactKinds,
  artifactPlan,
  readArtifactCatalog,
  withArtifactTag,
  type ArtifactDestination,
  type ArtifactPlanEntry,
  type ArtifactProfile,
  type ArtifactSelection,
} from "../core/artifacts/artifact-catalog.js";
import {
  artifactFileName,
  buildFileArtifact,
  exportFileArtifact,
  importFileArtifact,
  inspectFileArtifact,
  verifyFileArtifact,
} from "../core/artifacts/artifact-files.js";
import { InvalidInput } from "../core/runtime/input-errors.js";
import { terminalTable } from "../core/diagnostics/terminal-table.js";
import { required } from "../core/runtime/invariants.js";
import { chooseItems, terminalAvailable } from "./terminal/terminal-choice.js";
import { registerCommand } from "./commands.js";
import { offlineImageReference, offlineProfile, preparedOfflineProfile } from "../core/artifacts/offline-profiles.js";
import { exportPreparedImage, importPreparedImage } from "../core/artifacts/image-transfer.js";
import { runOfflineOperation } from "./development-images.js";
import { profileRequiresBinfmt } from "../core/artifacts/image-emulation.js";
import { editArtifactProfile } from "../core/artifacts/artifact-profile-edits.js";
import {
  artifactDestination,
  publishArtifactFiles,
  verifiedReleaseSource,
} from "../core/artifacts/artifact-release.js";
import { readUserConfig } from "../core/configuration/user-config.js";
import { prompt } from "./terminal/project-prompt.js";
import { inspectArtifactStates } from "../core/artifacts/artifact-status.js";
import { formatBytes } from "../core/runtime/byte-size.js";
import { CheckCancellation } from "../core/execution/checks/check-cancellation.js";

interface Options extends ArtifactSelection {
  kind?: string[];
  profilesFile?: string;
  toolchain?: string;
  json?: boolean;
  plan?: boolean;
  export?: string;
  publish?: string | true;
  force?: boolean;
  unverified?: boolean;
  verifiedOnTarget?: boolean;
  sha256?: string;
  generation?: string;
  registry?: boolean;
  sizes?: boolean;
}

function options(command: Command, tagRequired = false) {
  command
    .option(
      "--kind <kind>",
      "Select a kind; repeat to select several",
      (kind: string, kinds: string[]) => [...kinds, kind],
      [],
    )
    .option("--target <target>", "Select a declared target (default: this host)")
    .option("--format <format>", "Select a declared format")
    .option("--toolchain <name>", "Select a configured compiler or runtime profile")
    .option("--profiles-file <path>", "Use another profile catalog")
    .option("--json", "Emit structured results");
  return tagRequired
    ? command.requiredOption("--tag <tag>", "Select the reviewed version tag")
    : command.option("--tag <tag>", "Select a release version tag");
}

function generationOption(command: Command) {
  return command.option("--generation <id>", "Select a retained file artifact by generation ID");
}

function showPlan(rows: readonly ArtifactPlanEntry[], json?: boolean) {
  if (json) console.log(JSON.stringify(rows, null, 2));
  else
    console.log(
      terminalTable(
        ["Profile", "Project", "Kind", "Target", "Format"],
        rows.map((row) => [row.profile, row.definition.owner, row.kind, row.target, row.archive ?? row.format]),
      ),
    );
}

function selection(root: string, names: string[], selected: Options) {
  return artifactPlan(readArtifactCatalog(root, selected.profilesFile), {
    ...selected,
    profiles: names,
    kinds: selected.kind ?? [],
  });
}

function one(root: string, name: string, selected: Options) {
  const rows = selection(root, [name], selected);
  if (rows.length !== 1) throw new InvalidInput("Select exactly one artifact by profile, kind, target, and format");
  return required(rows[0], "Artifact selection is empty");
}

function imageOperation(root: string, row: ArtifactPlanEntry, toolchain?: string, generation?: string) {
  if (!("offlineProfile" in row.definition)) return undefined;
  if (generation !== undefined) throw new InvalidInput("Use --generation to select file artifacts");
  const profile = offlineProfile(root, row.definition.offlineProfile);
  if (toolchain && profile.toolchain !== toolchain)
    throw new InvalidInput(`${row.profile}: select a recipe configured for toolchain '${toolchain}'`);
  const architecture = row.platform === "linux-arm64" ? "arm64" : "x64";
  const reference = offlineImageReference(root, profile.name, architecture);
  return { profile, architecture, reference };
}

function requireImageHost(architecture: string) {
  if (process.platform !== "linux" || (process.arch !== architecture && profileRequiresBinfmt(architecture)))
    throw new InvalidInput(`OCI images require Linux ${architecture} or an approved binfmt handler for the target`);
}

type ImageOperation = NonNullable<ReturnType<typeof imageOperation>>;

function imageDestination(image: ImageOperation, configured?: ArtifactDestination): string {
  if (configured) {
    if (configured.kind !== "registry") throw new InvalidInput("OCI images require a registry destination");
    return configured.repository + image.reference.slice(image.reference.lastIndexOf(":"));
  }
  if (!image.profile.offline.registry) throw new InvalidInput("Select a configured registry destination");
  return image.reference;
}

function publishImage(root: string, image: ImageOperation, destination: string, json?: boolean) {
  runOfflineOperation(root, "publish", image.profile.name, {
    image: destination,
    architecture: image.architecture,
    ...(json ? { json: true } : {}),
  });
  return preparedOfflineProfile(root, image.profile, image.architecture);
}

async function build(root: string, rows: ArtifactPlanEntry[], selected: Options) {
  const destination =
    typeof selected.publish === "string"
      ? artifactDestination(root, selected.publish, selected.profilesFile)
      : undefined;
  const hosted = destination && destination.kind !== "registry" ? destination : undefined;
  if (selected.publish && selected.unverified) throw new InvalidInput("Verify artifacts before publication");
  if (hosted && rows.some(({ kind }) => kind !== "release"))
    throw new InvalidInput("Hosted publication requires a selection of release files");
  if (selected.publish && !hosted && rows.some(({ format }) => format !== "oci"))
    throw new InvalidInput("Select a registry for OCI images or a hosted release destination for release files");
  const tag = hosted ? required(selected.tag, "Supply the reviewed version tag with --tag") : undefined;
  if (selected.plan) {
    showPlan(rows, selected.json);
    return;
  }
  if (selected.unverified && !selected.export)
    throw new InvalidInput("Use --unverified with an explicit --export directory");
  // Resolve all host and packaging prerequisites before any recipe runs.
  const resolved = rows.map((row) => {
    const image = imageOperation(root, row, selected.toolchain);
    if (image) {
      requireImageHost(image.architecture);
      return { row, image, registry: selected.publish ? imageDestination(image, destination) : undefined };
    }
    artifactFileName(row);
    if (row.platform !== artifactHost() || row.workspace !== "host")
      throw new InvalidInput(`${row.profile}: ${row.format} requires a ${row.platform} host workspace`);
    return { row, image };
  });
  if (tag !== undefined) verifiedReleaseSource(root, tag);
  const failures: unknown[] = [];
  const outcomes = [];
  const builtGenerations: string[] = [];
  const publications = [];
  const cancellation = new CheckCancellation("Artifact build");
  try {
    for (const { row, image } of resolved) {
      const { profile, kind, target, format } = row;
      const subject = `${profile} ${kind} ${target} ${format}`;
      const selection = { profile, kind, target, format };
      if (!(await cancellation.ready())) {
        outcomes.push({ ...selection, status: "not-started" });
        if (!selected.json) console.log(`Did not start ${subject}`);
        continue;
      }
      try {
        if (image) {
          runOfflineOperation(root, "prepare", image.profile.name, {
            architecture: image.architecture,
            allowHostedBuild: true,
            ...(selected.json ? { json: true } : {}),
            ...(selected.force ? { build: true } : {}),
            ...(selected.unverified ? { assembleOnly: true } : {}),
          });
          const delivered = selected.export
            ? await exportPreparedImage(
                root,
                image.profile.name,
                image.architecture,
                selected.export,
                selected.unverified,
              )
            : undefined;
          const receipt = selected.unverified
            ? undefined
            : preparedOfflineProfile(root, image.profile, image.architecture);
          outcomes.push({ ...selection, reference: image.reference, receipt, delivered });
          if (!selected.json)
            console.log(
              delivered
                ? `Export ${delivered.directory}\nManifest SHA-256 ${delivered.manifestSha256}`
                : image.reference,
            );
          continue;
        }
        const artifact = await buildFileArtifact(root, row, selected.toolchain, selected.unverified);
        const delivered = selected.export
          ? await exportFileArtifact(artifact, selected.export, selected.unverified)
          : undefined;
        outcomes.push({ ...selection, artifact, delivered });
        builtGenerations.push(artifact.generation);
        if (!selected.json) {
          console.log(`${subject}\n  ${artifact.directory}`);
          if (delivered) console.log(`  Export ${delivered.directory}\n  Manifest SHA-256 ${delivered.manifestSha256}`);
        }
      } catch (error) {
        outcomes.push({ ...selection, status: cancellation.cancelled ? "cancelled" : "failed" });
        failures.push(new Error(subject, { cause: error }));
      }
    }
    if (selected.publish && !failures.length && (await cancellation.ready())) {
      if (hosted && tag !== undefined) {
        try {
          const publication = await publishArtifactFiles(root, rows, {
            destination: hosted,
            tag,
            builtGenerations,
            ...(selected.toolchain === undefined ? {} : { toolchain: selected.toolchain }),
          });
          publications.push(publication);
          if (!selected.json) console.log(`Published ${publication.tag}`);
        } catch (error) {
          failures.push(new Error("Publish release files", { cause: error }));
        }
      } else {
        for (const { row, image, registry } of resolved) {
          if (!(await cancellation.ready())) break;
          if (!image || !registry) continue;
          try {
            const receipt = publishImage(root, image, registry, selected.json);
            publications.push({ profile: row.profile, target: row.target, receipt });
          } catch (error) {
            failures.push(new Error(`Publish ${row.profile} ${row.target} ${row.kind}`, { cause: error }));
          }
        }
      }
    }
    if (selected.json)
      console.log(JSON.stringify(selected.publish ? { artifacts: outcomes, publications } : outcomes, null, 2));
    await cancellation.ready();
    cancellation.checkpoint();
    if (failures.length) throw new AggregateError(failures, `${String(failures.length)} artifact operations failed`);
  } finally {
    cancellation.close();
  }
}

async function publish(root: string, name: string, selected: Options & { destination?: string; tag?: string }) {
  const row = one(root, name, selected);
  const image = imageOperation(root, row, selected.toolchain, selected.generation);
  const configured = selected.destination
    ? artifactDestination(root, selected.destination, selected.profilesFile)
    : undefined;
  if (!image) {
    if (!configured || !selected.tag) throw new InvalidInput("Supply the publication destination and version tag");
    const result = await publishArtifactFiles(root, [row], {
      destination: configured,
      tag: selected.tag,
      ...(selected.toolchain !== undefined ? { toolchain: selected.toolchain } : {}),
      ...(selected.generation !== undefined ? { generations: [selected.generation] } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  requireImageHost(image.architecture);
  const receipt = publishImage(root, image, imageDestination(image, configured), selected.json);
  if (selected.json) console.log(JSON.stringify(receipt, null, 2));
}

const statusLabels = {
  verified: "Verified",
  unverified: "Needs verification",
  outdated: "Outdated",
  missing: "Missing",
  unavailable: "Unavailable",
};

function buildRequirement(row: ArtifactPlanEntry, settings: ReturnType<typeof readUserConfig>) {
  const arch = row.platform === "linux-arm64" ? "arm64" : "x64";
  if (row.format === "oci") {
    if (process.platform !== "linux" || (process.arch !== arch && profileRequiresBinfmt(arch)))
      return `Requires Linux ${arch} or binfmt`;
  } else if (row.platform !== artifactHost() || row.workspace !== "host")
    return `Requires ${row.platform} host workspace`;
  if (row.builder !== "native" && settings[`preparation.${row.builder}_store`] === "disabled")
    return `Enable ${row.builder} store to build locally`;
  return undefined;
}

async function list(root: string, selected: Options) {
  const catalog = readArtifactCatalog(root, selected.profilesFile);
  const rows = Object.entries(catalog.profiles).flatMap(([name, profile]) =>
    artifactPlan(catalog, {
      profiles: [name],
      kinds: [...new Set(profile.variants.map(({ kind }) => kind))],
      allTargets: true,
    }).map((row) => ({ row, projects: profile.projects })),
  );
  const states = await inspectArtifactStates(
    root,
    rows.map(({ row }) => row),
    selected,
  );
  const settings = readUserConfig();
  const output = rows.map(({ row, projects }) => {
    const result = required(states.get(row), "Missing artifact status");
    return {
      profile: row.profile,
      projects,
      kind: row.kind,
      target: row.target,
      format: row.format,
      recipe: row.recipe,
      platform: row.platform,
      local: result.state,
      reference: result.reference,
      generation: result.artifact?.generation,
      generationChoices: result.generationChoices,
      bytes: result.image?.bytes ?? result.artifact?.manifest.bytes,
      measuredAt: result.measuredAt,
      detail: result.detail,
      registry: result.registry,
      buildRequirement: buildRequirement(row, settings),
    };
  });
  const requirements = output.some((row) => row.buildRequirement !== undefined);
  const registry = output.some((row) => row.registry !== undefined);
  if (selected.json) console.log(JSON.stringify(output, null, 2));
  else if (!output.length) console.log("No artifact profiles configured.");
  else
    console.log(
      terminalTable(
        [
          "Profile",
          "Projects",
          "Kind",
          "Target",
          "Format",
          "Local",
          ...(requirements ? ["Build"] : []),
          ...(selected.sizes ? ["Size", "Measured at"] : []),
          ...(registry ? ["Registry"] : []),
        ],
        output.map((row) => [
          row.profile,
          row.projects.join(", "),
          row.kind,
          row.target,
          row.format,
          row.generationChoices ? "Select generation" : statusLabels[row.local],
          ...(requirements ? [row.buildRequirement ?? ""] : []),
          ...(selected.sizes ? [formatBytes(row.bytes), row.measuredAt ?? ""] : []),
          ...(registry ? [row.registry?.state ?? ""] : []),
        ]),
      ),
    );
}

interface Choice<T extends string> {
  name: T;
  label: string;
}

async function chooseOne<T extends string>(title: string, values: Choice<T>[]) {
  const first = required(values[0], `No choices for ${title.toLowerCase()}`);
  console.log(title);
  if (values.length === 1) {
    console.log(`  ${first.label}`);
    return first.name;
  }
  for (const [index, { label }] of values.entries()) console.log(`  ${String(index + 1)}. ${label}`);
  const answer = await prompt("Selection", "1");
  const selected = /^\d+$/.test(answer) ? values[Number(answer) - 1] : undefined;
  if (!selected) throw new InvalidInput(`Select a number from 1 to ${String(values.length)}`);
  return selected.name;
}

async function chooseMany(title: string, values: Choice<string>[], defaults: string[]) {
  return values.length === 1 ? [await chooseOne(title, values)] : chooseItems(title, values, defaults);
}

type Catalog = ReturnType<typeof readArtifactCatalog>;

function artifactTargets(catalog: Catalog, profile: ArtifactProfile) {
  const host = artifactHost();
  return [...new Set(profile.variants.map(({ target }) => target))].sort(
    (a, b) => Number(catalog.targets[b]?.platform === host) - Number(catalog.targets[a]?.platform === host),
  );
}

function buildableProfile(catalog: Catalog, profile: ArtifactProfile): ArtifactProfile {
  const host = artifactHost();
  return {
    ...profile,
    variants: profile.variants.filter(({ target, formats }) => {
      const platform = catalog.targets[target]?.platform;
      return formats.includes("oci")
        ? process.platform === "linux" &&
            (platform === host || !profileRequiresBinfmt(platform === "linux-arm64" ? "arm64" : "x64"))
        : platform === host && profile.workspace === "host";
    }),
  };
}

function profileChoices(profiles: Record<string, ArtifactProfile>) {
  return Object.entries(profiles).map(([name, profile]) => ({
    name,
    label: `${name}  ${profile.projects.join(", ")}`,
  }));
}

async function configureProfile(
  catalog: Catalog,
  templates: Record<string, ArtifactProfile>,
  current?: ArtifactProfile,
) {
  const usable = Object.fromEntries(
    Object.entries(templates).filter(
      ([, profile]) =>
        !current ||
        (profile.builder === current.builder &&
          profile.workspace === current.workspace &&
          profile.projects.length === current.projects.length &&
          profile.projects.every((project) => current.projects.includes(project))),
    ),
  );
  const template = await chooseOne("Use recipes from", profileChoices(usable));
  const profile = required(usable[template], "Unknown artifact profile");
  const targets = artifactTargets(catalog, profile);
  const targetDefaults = current
    ? targets.filter((target) => current.variants.some((variant) => variant.target === target))
    : targets.filter((target) => catalog.targets[target]?.platform === artifactHost());
  const selected = await chooseMany(
    "Select profile targets",
    targets.map((name) => ({ name, label: name })),
    targetDefaults.length ? targetDefaults : targets.slice(0, 1),
  );
  if (!selected?.length) return;
  const outputs = profile.variants
    .filter((variant) => selected.includes(variant.target))
    .flatMap((variant) => variant.formats.map((format) => ({ variant, format })));
  const choices = outputs.map(({ variant, format }, index) => ({
    name: String(index),
    label: `${variant.target}  ${variant.kind}  ${format}  ${catalog.recipes[variant.recipe]?.owner ?? ""}`,
  }));
  const defaults = choices.filter(({ name }) => {
    const { variant, format } = required(outputs[Number(name)], "Unknown artifact output");
    const existingTarget = current?.variants.some((existing) => existing.target === variant.target);
    return (
      !existingTarget ||
      current?.variants.some(
        (existing) =>
          existing.target === variant.target &&
          existing.kind === variant.kind &&
          existing.recipe === variant.recipe &&
          existing.formats.includes(format),
      )
    );
  });
  const kept = await chooseMany(
    "Select available outputs for this profile",
    choices,
    defaults.map(({ name }) => name),
  );
  if (!kept?.length) return;
  const variants = new Map<ArtifactProfile["variants"][number], ArtifactProfile["variants"][number]>();
  for (const name of kept) {
    const { variant, format } = required(outputs[Number(name)], "Unknown artifact output");
    const entry = variants.get(variant);
    if (entry) entry.formats.push(format);
    else variants.set(variant, { ...variant, formats: [format] });
  }
  return { ...profile, variants: [...variants.values()] };
}

async function useProfile(root: string, catalog: Catalog, name: string, configured: ArtifactProfile) {
  const profile = buildableProfile(catalog, configured);
  if (!profile.variants.length) {
    console.log("This profile has no outputs available on this host.");
    return;
  }
  const target = await chooseOne(
    "Select target",
    artifactTargets(catalog, profile).map((name) => ({ name, label: name })),
  );
  const kinds = artifactKinds.filter((kind) =>
    profile.variants.some((variant) => variant.target === target && variant.kind === kind),
  );
  const selected = await chooseMany(
    "Select artifact kinds",
    kinds.map((name) => ({ name, label: name })),
    [],
  );
  if (!selected?.length) return;
  const plan = artifactPlan(
    { ...catalog, profiles: { [name]: profile } },
    { profiles: [name], kinds: selected, target },
  );
  const outputs = plan.map((row, index) => ({
    name: String(index),
    label: `${row.kind}  ${row.archive ?? row.format}  ${row.definition.owner}`,
  }));
  const rows = await chooseMany(
    "Select outputs",
    outputs,
    outputs.map(({ name }) => name),
  );
  if (!rows?.length) return;
  const chosen = rows.map((index) => required(plan[Number(index)], "Unknown artifact selection"));
  const images = chosen.every(({ format }) => format === "oci");
  const releases = chosen.every(({ kind }) => kind === "release");
  const destinations = Object.entries(catalog.destinations).filter(([, { kind }]) =>
    kind === "registry" ? images : releases,
  );
  const profileRegistries =
    images &&
    chosen.every(
      ({ definition }) =>
        "offlineProfile" in definition && Boolean(offlineProfile(root, definition.offlineProfile).offline.registry),
    );
  if (destinations.length || profileRegistries) {
    const delivery = await chooseOne("Deliver artifacts", [
      { name: "local", label: "Retain locally" },
      { name: "export", label: "Export to a directory" },
      ...(profileRegistries ? [{ name: "registries", label: "Publish to the selected profiles' registries" }] : []),
      ...destinations.map(([name]) => ({ name: `destination:${name}`, label: `Publish to ${name}` })),
    ]);
    if (delivery === "local") return build(root, chosen, {});
    if (delivery === "registries") return build(root, chosen, { publish: true });
    if (delivery.startsWith("destination:")) {
      const publish = delivery.slice("destination:".length);
      const tag = releases ? await prompt("Reviewed version tag") : undefined;
      return build(
        root,
        chosen.map((row) => withArtifactTag(row, tag)),
        { publish, ...(tag === undefined ? {} : { tag }) },
      );
    }
  }
  const directory = await prompt("Export directory (leave blank to retain outputs locally)");
  await build(root, chosen, directory ? { export: directory } : {});
}

async function interactive(root: string, command: Command) {
  if (!terminalAvailable()) {
    command.outputHelp();
    return;
  }
  const catalog = readArtifactCatalog(root);
  const settings = readUserConfig();
  const available = Object.fromEntries(
    Object.entries(catalog.profiles).filter(
      ([, profile]) => profile.builder === "native" || settings[`preparation.${profile.builder}_store`] !== "disabled",
    ),
  );
  const action = await chooseOne("Artifact profiles", [
    { name: "run", label: "Build from a saved profile" },
    { name: "custom", label: "Build from a custom selection" },
    { name: "manage", label: "Manage profiles" },
  ]);
  const save = async (operation: "add" | "edit" | "remove", name: string, profile?: ArtifactProfile) => {
    const edit = editArtifactProfile(root, operation, name, profile);
    if (profile) {
      console.log(`Profile ${name} · ${profile.builder} · ${profile.projects.join(", ")}`);
      console.log(
        terminalTable(
          ["Target", "Kind", "Formats"],
          profile.variants.map((variant) => [variant.target, variant.kind, variant.formats.join(", ")]),
        ),
      );
    }
    if (
      !/^y(?:es)?$/i.test(
        await prompt(operation === "remove" ? `Remove profile ${name}? [y/N]` : "Save profile? [y/N]"),
      )
    )
      return false;
    edit.apply();
    console.log(operation === "remove" ? `Removed profile ${name}.` : `Saved profile ${name}.`);
    return true;
  };
  if (action === "manage") {
    if (!Object.keys(catalog.profiles).length) {
      console.log("Define a profile with workbench artifact add NAME --from FILE --apply before using guided editing.");
      return;
    }
    const operation = await chooseOne("Manage profiles", [
      ...(Object.keys(available).length ? [{ name: "add" as const, label: "Add" }] : []),
      ...(Object.keys(catalog.profiles).length
        ? [
            { name: "edit" as const, label: "Edit" },
            { name: "remove" as const, label: "Remove" },
          ]
        : []),
    ]);
    const name =
      operation === "add"
        ? await prompt("New profile name")
        : await chooseOne("Select a profile", profileChoices(catalog.profiles));
    if (operation === "remove") {
      await save(operation, name);
      return;
    }
    const profile = await configureProfile(
      catalog,
      operation === "add"
        ? available
        : { [name]: required(catalog.profiles[name], "Unknown artifact profile"), ...catalog.profiles },
      operation === "edit" ? catalog.profiles[name] : undefined,
    );
    if (profile) await save(operation, name, profile);
    return;
  }
  const runnable = Object.fromEntries(
    Object.entries(available)
      .map(([name, profile]) => [name, buildableProfile(catalog, profile)] as const)
      .filter(([, profile]) => profile.variants.length),
  );
  if (!Object.keys(runnable).length) {
    console.log("No artifact profiles support this host.");
    return;
  }
  if (action === "run") {
    const name = await chooseOne("Choose an artifact profile", profileChoices(runnable));
    await useProfile(root, catalog, name, required(runnable[name], "Unknown artifact profile"));
    return;
  }
  const profile = await configureProfile(catalog, runnable);
  if (!profile) return;
  let name = "custom";
  if (/^y(?:es)?$/i.test(await prompt("Save this selection as a profile? [y/N]"))) {
    const saved = await prompt("New profile name");
    if (await save("add", saved, profile)) name = saved;
  }
  await useProfile(root, catalog, name, profile);
}

export function registerArtifactCommands(program: Command, root: string): void {
  const artifact = registerCommand(program, "artifact").description(
    "Build, verify, and transfer configured project artifacts",
  );
  artifact.action(() => interactive(root, artifact));
  for (const operation of ["add", "edit", "remove"] as const) {
    const command = artifact.command(operation).description(`Preview or ${operation} a profile`).argument("<name>");
    if (operation !== "remove") command.requiredOption("--from <file>", "Read a profile from a TOML file");
    command
      .option("--apply", "Apply the validated change")
      .action((name: string, selection: { from?: string; apply?: boolean }) => {
        const edit = editArtifactProfile(root, operation, name, selection.from);
        console.log(JSON.stringify(selection.apply ? edit.apply() : edit.preview, null, 2));
      });
  }
  artifact
    .command("list")
    .description("List artifacts and the state of their local outputs")
    .option("--profiles-file <path>", "Use another profile catalog")
    .option("--registry", "Check configured registries for the current images")
    .option("--sizes", "Show retained output sizes and measurement times")
    .option("--json", "Emit structured results")
    .action((selected: Options) => list(root, selected));
  options(artifact.command("build").description("Build one or more selected outputs").argument("[profiles...]"))
    .option("--all", "Select matching outputs across all profiles")
    .option("--plan", "Show selections without acquiring tools")
    .option("--force", "Assemble and verify new OCI images")
    .option("--export <directory>", "Deliver the built artifacts to a directory")
    .option("--publish [destination]", "Publish verified outputs to a configured destination")
    .option("--unverified", "Explicitly export candidates before target verification")
    .action((profiles: string[], selected: Options) => build(root, selection(root, profiles, selected), selected));
  generationOption(
    options(
      artifact.command("inspect").description("Inspect a retained artifact and its verification").argument("<profile>"),
    ),
  )
    .option("--registry", "Check the configured registry for this image")
    .action(async (profile: string, selected: Options) => {
      const row = one(root, profile, selected);
      if (selected.generation !== undefined) {
        imageOperation(root, row, selected.toolchain, selected.generation);
        const retained = inspectFileArtifact(root, row, selected.toolchain, selected.generation);
        console.log(
          retained
            ? JSON.stringify(retained, null, 2)
            : selected.json
              ? "{}"
              : "No retained output for that generation.",
        );
        return;
      }
      const status = required((await inspectArtifactStates(root, [row], selected)).get(row), "Missing artifact status");
      console.log(
        JSON.stringify(
          { ...status, requirements: row.requirements, buildRequirement: buildRequirement(row, readUserConfig()) },
          null,
          2,
        ),
      );
    });
  generationOption(
    options(
      artifact.command("verify").description("Check a retained artifact on its target host").argument("<profile>"),
    ),
  ).action(async (profile: string, selected: Options) => {
    const row = one(root, profile, selected);
    const image = imageOperation(root, row, selected.toolchain, selected.generation);
    if (image) {
      requireImageHost(image.architecture);
      runOfflineOperation(root, "verify", image.profile.name, {
        architecture: image.architecture,
        ...(selected.json ? { json: true } : {}),
      });
      if (selected.json)
        console.log(JSON.stringify(preparedOfflineProfile(root, image.profile, image.architecture), null, 2));
      return;
    }
    const result = await verifyFileArtifact(root, row, selected.toolchain, selected.generation);
    console.log(selected.json ? JSON.stringify(result, null, 2) : `Verified ${result.directory}`);
  });
  generationOption(
    options(
      artifact
        .command("export")
        .description("Transfer a retained artifact to a directory")
        .argument("<profile>")
        .argument("<directory>"),
    ),
  )
    .option("--unverified", "Explicitly transfer a candidate before target verification")
    .action(async (profile: string, directory: string, selected: Options) => {
      const row = one(root, profile, selected);
      const image = imageOperation(root, row, selected.toolchain, selected.generation);
      let delivery;
      if (image)
        delivery = await exportPreparedImage(
          root,
          image.profile.name,
          image.architecture,
          directory,
          selected.unverified,
        );
      else {
        const result = inspectFileArtifact(root, row, selected.toolchain, selected.generation);
        if (!result) throw new InvalidInput("Build or import the selected artifact before exporting it");
        delivery = await exportFileArtifact(result, directory, selected.unverified);
      }
      console.log(
        selected.json
          ? JSON.stringify(delivery, null, 2)
          : `${delivery.directory}\nManifest SHA-256 ${delivery.manifestSha256}`,
      );
    });
  options(
    artifact
      .command("import")
      .description("Authenticate and verify an artifact on the receiving host")
      .argument("<profile>")
      .argument("<directory>"),
  )
    .requiredOption("--sha256 <sha256>", "Trusted digest of the transferred manifest")
    .option("--verified-on-target", "Use release verification from the authenticated export")
    .action(async (profile: string, directory: string, selected: Options) => {
      const row = one(root, profile, selected);
      const expected = required(selected.sha256, "The transferred manifest needs a trusted SHA-256");
      const image = imageOperation(root, row, selected.toolchain);
      if (image) {
        requireImageHost(image.architecture);
        if (selected.verifiedOnTarget)
          throw new InvalidInput("OCI imports must run offline verification on the receiving host");
        const imported = await importPreparedImage(root, image.profile.name, image.architecture, directory, expected);
        console.log(selected.json ? JSON.stringify(imported, null, 2) : `Verified ${imported.reference}`);
        return;
      }
      const imported = await importFileArtifact(root, row, directory, expected, {
        ...(selected.toolchain === undefined ? {} : { toolchain: selected.toolchain }),
        ...(selected.verifiedOnTarget ? { verifiedOnTarget: true } : {}),
      });
      console.log(
        selected.json ? JSON.stringify(imported, null, 2) : `Imported ${imported.generation}\n  ${imported.directory}`,
      );
    });
  generationOption(
    options(
      artifact
        .command("publish")
        .description("Deliver a verified artifact to a configured destination")
        .argument("<profile>"),
    ),
  )
    .option("--destination <name>", "Select a configured destination")
    .action((profile: string, selected: Options & { destination?: string; tag?: string }) =>
      publish(root, profile, selected),
    );

  const release = required(
    program.commands.find((command) => command.name() === "release"),
    "Release command",
  );
  options(
    release
      .command("publish")
      .description("Publish verified release files and record their identities")
      .argument("<profiles...>"),
    true,
  )
    .option(
      "--generation <id>",
      "Select a retained artifact by ID; repeat to publish several outputs together",
      (id: string, generations: string[]) => [...generations, id],
      [],
    )
    .requiredOption("--destination <name>", "Select a GitHub or GitLab destination")
    .option("--summary <text>", "Provide a one-line release summary")
    .action(
      async (
        profiles: string[],
        selected: Omit<Options, "generation"> & {
          generation: string[];
          destination: string;
          tag: string;
          summary?: string;
        },
      ) => {
        const { generation: generations, ...configuration } = selected;
        const rows = selection(root, profiles, {
          ...configuration,
          kind: ["release"],
          allTargets: generations.length > 0,
        });
        const result = await publishArtifactFiles(root, rows, {
          destination: artifactDestination(root, selected.destination, selected.profilesFile),
          tag: selected.tag,
          recordRelease: true,
          ...(selected.summary !== undefined ? { summary: selected.summary } : {}),
          ...(selected.toolchain !== undefined ? { toolchain: selected.toolchain } : {}),
          generations,
        });
        if (selected.json) console.log(JSON.stringify(result, null, 2));
        else console.log(`Published ${result.tag}\n  Release record ${result.release ?? ""}`);
      },
    );
}
