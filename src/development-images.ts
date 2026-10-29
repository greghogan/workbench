import { UserFacingError, formatDiagnosticSections } from "../scripts/diagnostics.mjs";
import { inspectOfflineImages } from "./offline-profiles.js";
import { runCommand } from "./check-command.js";
import { chooseItems, terminalAvailable } from "./terminal-choice.js";
import { terminalTable } from "./terminal-table.js";
import { ImageExecution, RegistryAvailability, ImagePreparation } from "./image-contract.js";

export interface ImageOptions {
  require?: boolean;
  json?: boolean;
  list?: boolean;
  architecture?: string;
}
type ImageState = Awaited<ReturnType<typeof inspectOfflineImages>>;
type OfflineOperation = "prepare" | "verify" | "publish";

/** Interactive and explicit operations share tool selection, policy checks, and cancellation. */
export function runOfflineOperation(
  root: string,
  operation: OfflineOperation,
  profile: string,
  options: {
    image?: string;
    build?: boolean;
    pullOnly?: boolean;
    fresh?: boolean;
    architecture?: string;
    assembleOnly?: boolean;
  } = {},
): void {
  runCommand(
    root,
    `development ${operation}`,
    [
      "node",
      "{workbench}/bin/workbench.mjs",
      "offline-exec",
      operation,
      profile,
      ...(options.image ? [options.image] : []),
      ...(options.build ? ["--build"] : []),
      ...(options.pullOnly ? ["--pull-only"] : []),
      ...(options.fresh ? ["--fresh"] : []),
      ...(options.assembleOnly ? ["--assemble-only"] : []),
      ...(options.architecture ? ["--architecture", options.architecture] : []),
    ],
    "native",
    root,
    undefined,
    false,
  );
}

function present(rows: ImageState): void {
  const header = ["PROFILE", "LOCAL", "REGISTRY", "IMAGE / DETAILS"];
  const values: string[][] = [];
  const separators: { after: number }[] = [];
  for (const row of rows) {
    values.push([row.profile, row.local, row.registry, row.reference]);
    if (row.verificationMethod === ImageExecution.Binfmt)
      values.push(["", "", "", `Verification: binfmt on ${row.verificationHost ?? "unknown host"}`]);
    if (row.detail) values.push(["", "", "", `Registry: ${row.detail}`]);
    for (const issue of row.local_issues ?? []) values.push(["", "", "", `Local image inspection: ${issue}`]);
    separators.push({ after: values.length - 1 });
  }
  const statusWidth = header
    .slice(0, 3)
    .reduce(
      (total, label, column) => total + Math.max(label.length, ...values.map((row) => row[column]?.length ?? 0)),
      0,
    );
  console.log(
    terminalTable(header, values, {
      // Four columns need 13 border/padding characters; reserve one terminal column.
      maxWidths: { 3: (process.stdout.columns || 80) - statusWidth - 14 },
      separators,
    }),
  );
}

/** Inspect first; preparation and publication each require their own terminal selection. */
export async function developmentImages(root: string, profiles: string[], options: ImageOptions): Promise<void> {
  let rows = await inspectOfflineImages(root, profiles, options.architecture);
  if (options.json) console.log(JSON.stringify(rows, null, 2));
  else present(rows);
  if (options.require) {
    const missing = rows.filter((row) => row.registry !== RegistryAvailability.Available);
    if (!rows.length) throw new Error("No development image profiles are configured");
    if (missing.length)
      throw new UserFacingError(
        formatDiagnosticSections({
          summary: "Required registry images are unavailable.",
          groups: [
            {
              heading: "Not published",
              items: missing.filter((row) => row.registry === RegistryAvailability.Missing).map((row) => row.profile),
            },
            {
              heading: "Registry not configured",
              items: missing
                .filter((row) => row.registry === RegistryAvailability.NotConfigured)
                .map((row) => row.profile),
            },
            {
              heading: "Registry check failed",
              items: missing
                .filter((row) => row.registry === RegistryAvailability.Unavailable)
                .map((row) => row.profile),
            },
          ],
          next: "Use workbench development images to inspect these profiles and select preparation or publication. Check registry configuration and access for registry failures.",
        }),
        {
          cause: new AggregateError(
            missing.map(
              (row) =>
                new Error(`${row.profile}: ${row.registry}\n${row.reference}${row.detail ? `\n${row.detail}` : ""}`),
            ),
            "Development image availability failed",
          ),
        },
      );
    return;
  }
  const hosted = [process.env.CI, process.env.GITHUB_ACTIONS, process.env.GITLAB_CI].some(
    (value) => value && value !== "false" && value !== "0",
  );
  if (options.json || options.list || hosted || !terminalAvailable() || !rows.length) return;
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
    console.log("Prepare and publish these images on a Linux x64 or ARM64 host.");
    return;
  }
  for (const operation of ["prepare", "publish"] as const) {
    const candidates = rows.filter((row) =>
      operation === "prepare"
        ? row.local !== ImagePreparation.Prepared
        : row.local === ImagePreparation.Prepared &&
          ![RegistryAvailability.Available, RegistryAvailability.NotConfigured].some((state) => state === row.registry),
    );
    if (!candidates.length) continue;
    const selected = await chooseItems(
      operation === "prepare" ? "Prepare selected development images" : "Publish selected development images",
      candidates.map((row) => ({
        name: row.profile,
        label: `${row.profile}: ${row.reference}`,
      })),
      candidates.map((row) => row.profile),
    );
    if (selected === undefined) return;
    for (const name of selected) {
      const before = candidates.find((row) => row.profile === name);
      const current = (await inspectOfflineImages(root, [name], options.architecture))[0];
      if (!before || current?.reference !== before.reference)
        throw new Error("Image inputs changed during selection; run workbench development images again");
      if (
        operation === "prepare"
          ? current.local === ImagePreparation.Prepared
          : current.registry === RegistryAvailability.Available
      )
        continue;
      runOfflineOperation(root, operation, name, options.architecture ? { architecture: options.architecture } : {});
    }
    if (selected.length) {
      rows = await inspectOfflineImages(root, profiles, options.architecture);
      present(rows);
    }
  }
}
