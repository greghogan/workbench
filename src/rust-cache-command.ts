import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { formatBytes } from "./byte-size.js";
import { hasCollectionProject } from "./collections.js";
import { CacheBusy } from "./cache-lock.js";
import { inspectToolReferences, type ResultToolReference } from "./tool-references.js";
import { pruneRustCache, RustArtifactKind, type RustCachePlan, type RustCachePolicy } from "./rust-cache.js";
import { terminalTable } from "./terminal-table.js";
import { chooseItems, terminalAvailable } from "./terminal-choice.js";
import { userConfigValues } from "./user-config.js";
import { CheckCancellation } from "./check-cancellation.js";

export interface RustPruneOptions {
  all?: boolean;
  checkout?: string;
  path?: string;
  apply?: boolean;
  json?: boolean;
}
interface Selection {
  reference: ResultToolReference;
  plan?: RustCachePlan;
  blockedBy?: string;
}
const policy = (): RustCachePolicy => {
  const settings = userConfigValues();
  return {
    maxBytes: settings["cache.rust_max_bytes"] as number,
    maxAgeDays: settings["cache.rust_max_age_days"] as number,
  };
};
/** Fresh selection and exact reviewed digests are independent of the cached size inventory. */
export async function pruneRustCommand(root: string, options: RustPruneOptions): Promise<void> {
  const cancellation = new CheckCancellation("Rust cache pruning");
  try {
    await pruneRust(root, options, cancellation);
  } catch (error) {
    cancellation.checkpoint();
    throw error;
  } finally {
    cancellation.close();
  }
}
async function pruneRust(root: string, options: RustPruneOptions, cancellation: CheckCancellation): Promise<void> {
  if (options.all && options.checkout) throw new Error("Select --all or --checkout, not both");
  if (["tools", "builders", "images"].includes(options.checkout ?? ""))
    throw new Error("Rust pruning requires a checkout selection");
  const requested = options.checkout
    ? resolve(options.checkout)
    : options.all
      ? undefined
      : hasCollectionProject(root)
        ? root
        : undefined;
  const checkout = requested && existsSync(requested) ? realpathSync(requested) : requested;
  const references = inspectToolReferences();
  if (references.issues.length)
    throw new Error("Rust cache references are unavailable: " + references.issues.join("; "));
  const limits = policy();
  const selections: Selection[] = [];
  for (const reference of references.results) {
    if (
      reference.kind !== "builds" ||
      reference.platform !== `${process.platform}-${process.arch}` ||
      !reference.verifiedAt ||
      !reference.tools.some((tool) => tool.tool === "rust") ||
      (checkout && reference.identity.checkout !== checkout) ||
      (options.path !== undefined && reference.identity.root !== options.path) ||
      !existsSync(resolve(reference.directory, "cargo"))
    )
      continue;
    try {
      selections.push({ reference, plan: await pruneRustCache(reference, limits, { signal: cancellation.signal }) });
    } catch (error) {
      if (!(error instanceof CacheBusy)) throw error;
      selections.push({ reference, blockedBy: error.message });
    }
  }
  const available = selections.filter((selection) => !!selection.plan?.selected.length);
  let selected = options.apply ? available.map((selection) => selection.reference.directory) : [];
  if (!options.apply && !options.json && terminalAvailable() && available.length) {
    selected =
      (await chooseItems(
        "Select Rust caches to prune",
        selections.map((selection) => ({
          name: selection.reference.directory,
          label: selection.reference.identity.checkout + "/" + selection.reference.identity.root,
          reason:
            selection.blockedBy ??
            `${String(selection.plan?.selected.length ?? 0)} groups; ${formatBytes(selection.plan?.selected.reduce((sum, group) => sum + group.bytes, 0))}`,
          disabled: () => !selection.plan?.selected.length,
        })),
        available.map((selection) => selection.reference.directory),
        undefined,
        undefined,
        (names) =>
          `Remove the reviewed Rust artifact groups in ${String(names.length)} cache(s), including selected incremental sessions?`,
      )) ?? [];
  }
  for (const selection of selections) {
    cancellation.checkpoint();
    const previous = selection.plan;
    if (!previous || !selected.includes(selection.reference.directory)) continue;
    selection.plan = await pruneRustCache(selection.reference, limits, {
      apply: true,
      expected: previous.digest,
      signal: cancellation.signal,
      validate: () => {
        const current = policy();
        if (current.maxBytes !== limits.maxBytes || current.maxAgeDays !== limits.maxAgeDays)
          throw new Error("Rust retention policy changed; inspect a fresh preview");
      },
    });
  }
  if (options.json) console.log(JSON.stringify({ schema_version: 1, applied: !!options.apply, selections }, null, 2));
  else if (!selections.length) console.log("No verified owned Rust caches match this selection.");
  else
    console.log(
      terminalTable(
        ["CHECKOUT", "ROOT", "GROUPS", "INCREMENTAL", "SELECTED SIZE", "STATUS"],
        selections.map(({ reference, plan, blockedBy }) => [
          reference.identity.checkout,
          reference.identity.root,
          String(plan?.selected.length ?? 0),
          String(plan?.selected.filter((group) => group.kind === RustArtifactKind.Incremental).length ?? 0),
          formatBytes(plan?.selected.reduce((sum, group) => sum + group.bytes, 0)),
          blockedBy ?? (selected.includes(reference.directory) ? "removed" : "preview"),
        ]),
        { quantities: [4] },
      ),
    );
}
