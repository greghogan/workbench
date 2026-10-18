import { inspectOfflineImages } from "./offline-profiles.js";
import { runCommand } from "./checks.js";
import { chooseItems, terminalAvailable } from "./terminal-choice.js";
import { terminalTable } from "./terminal-table.js";

export interface ImageOptions {
  require?: boolean;
  json?: boolean;
  list?: boolean;
}
type ImageState = ReturnType<typeof inspectOfflineImages>;
type OfflineOperation = "prepare" | "verify" | "publish";

/** Interactive and explicit operations share tool selection, policy checks, and cancellation. */
export function runOfflineOperation(
  root: string,
  operation: OfflineOperation,
  profile: string,
  options: { image?: string; build?: boolean; pullOnly?: boolean; fresh?: boolean } = {},
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
  let rows = inspectOfflineImages(root, profiles);
  if (options.json) console.log(JSON.stringify(rows, null, 2));
  else present(rows);
  if (options.require) {
    const missing = rows.filter((row) => row.registry !== "available");
    if (!rows.length || missing.length)
      throw new Error(
        `Required registry images are unavailable${missing.length ? `: ${missing.map((row) => row.profile).join(", ")}` : ""}; prepare and publish them before running CI`,
      );
    return;
  }
  const hosted = [process.env.CI, process.env.GITHUB_ACTIONS, process.env.GITLAB_CI].some(
    (value) => value && value !== "false" && value !== "0",
  );
  if (options.json || options.list || hosted || !terminalAvailable() || !rows.length) return;
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
    console.log("Prepare and publish these images on a native Linux x64 or ARM64 builder.");
    return;
  }
  for (const operation of ["prepare", "publish"] as const) {
    const candidates = rows.filter((row) =>
      operation === "prepare"
        ? row.local !== "prepared"
        : row.local === "prepared" && !["available", "not configured"].includes(row.registry),
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
      const current = inspectOfflineImages(root, [name])[0];
      if (!before || current?.reference !== before.reference)
        throw new Error("Image inputs changed during selection; run workbench development images again");
      if (operation === "prepare" ? current.local === "prepared" : current.registry === "available") continue;
      runOfflineOperation(root, operation, name);
    }
    if (selected.length) {
      rows = inspectOfflineImages(root, profiles);
      present(rows);
    }
  }
}
