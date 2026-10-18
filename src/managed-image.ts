import { guixChannelGroups, validateManagedPlan } from "../scripts/managed-contract.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { distributionRoot, readLanguageRoots } from "./core.js";
import { buildPaths, prepareBuildDependencies } from "./builds.js";
import { managedProfilePath, prepareManagedProfile } from "./managed-profiles.js";
import { withCacheLocksSync } from "./cache-lock.js";
import { CheckCancellation } from "./check-cancellation.js";

export function managedImageRoots(root: string, selection?: unknown): string[] {
  const registered = new Set(readLanguageRoots(root).map((entry) => entry.path));
  const roots = selection === undefined ? [...registered] : selection;
  if (
    !Array.isArray(roots) ||
    !roots.length ||
    new Set(roots).size !== roots.length ||
    roots.some((entry: unknown) => typeof entry !== "string" || !registered.has(entry))
  )
    throw new Error("Managed image preparation requires distinct registered project roots");
  return roots as string[];
}

/** Image assembly and host shells share the same store, dependency identities, and GC registrations. */
export async function prepareHostManagedImage(
  root: string,
  builder: string,
  image: string,
  rootsFile: string,
  output: string,
): Promise<void> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
    throw new Error("Managed image preparation requires native Linux x64 or ARM64");
  if (builder !== "nix" && builder !== "guix") throw new Error("Managed image preparation requires nix or guix");
  const roots = managedImageRoots(root, JSON.parse(readFileSync(rootsFile, "utf8")));
  const paths = roots.map((path) => buildPaths(root, resolve(root, path), builder));
  const first = paths[0];
  if (!first) throw new Error("Image preparation has no profile owner");
  const runtime = builder === "guix" ? managedProfilePath(first, "runtime") : undefined;
  const archive = builder === "guix" ? managedProfilePath(first, "image") : join(output, "image-root");
  const guix =
    builder === "guix"
      ? guixChannelGroups(
          root,
          roots.map((path) => ({ path })),
        ).map((group) => {
          const owner = paths[group.roots[0] ?? -1];
          if (!owner) throw new Error("Guix channel group lost its owner");
          return {
            ...group,
            runtime: managedProfilePath(owner, "runtime"),
            imageRoot: managedProfilePath(owner, "image"),
          };
        })
      : undefined;
  const preparation = validateManagedPlan({
    builder,
    roots: paths.map((path, index) => ({ path: roots[index], profile: managedProfilePath(path) })),
    runtime,
    guix,
    imageRoot: archive,
    runtimeOwner: first.dependencies,
    output,
    cores: Number(process.env.WORKBENCH_MANAGED_CORES),
    maxJobs: Number(process.env.WORKBENCH_MANAGED_JOBS),
  });
  const cancellation = new CheckCancellation("Image preparation");
  const assemble = async () => {
    cancellation.checkpoint();
    for (const [index, path] of paths.entries()) {
      prepareBuildDependencies(path);
      const selected = preparation.roots[index];
      if (!selected) throw new Error("Managed profile plan lost a selected root");
      prepareManagedProfile(path, selected.profile);
    }
    for (const group of preparation.guix ?? []) {
      const owner = paths[group.roots[0] ?? -1];
      if (!owner) throw new Error("Guix channel group lost its owner");
      prepareManagedProfile(owner, group.runtime, "runtime");
      prepareManagedProfile(owner, group.imageRoot, "image");
    }
    const plan = join(output, "host-profiles.json");
    writeFileSync(plan, JSON.stringify(preparation), { mode: 0o600 });
    await cancellation.execute(
      [process.execPath, join(distributionRoot(root), "scripts/prepare-host-managed-development.mjs"), builder, image],
      root,
      {
        ...process.env,
        ...(builder === "guix" ? { GUIX_BUILD_OPTIONS: undefined } : {}),
        WORKBENCH_ROOTS_FILE: rootsFile,
        WORKBENCH_MANAGED_OUTPUT: output,
      },
    );
  };
  try {
    await withCacheLocksSync(paths.map((path) => path.dependencies).sort(), assemble);
  } finally {
    cancellation.close();
  }
}
