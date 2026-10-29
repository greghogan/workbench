import { execFileSync } from "node:child_process";
import { readConfig } from "./project-configuration.js";
import {
  CIProvider,
  repositoryIdentity,
  repositoryTransport,
  type CIDestination,
  type ImageBuilder,
} from "./ci-hosting.js";

export function remoteTransport(root: string, remote: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(remote)) throw new Error("Invalid Git remote name");
  const urls = execFileSync("git", ["-C", root, "remote", "get-url", "--push", "--all", remote], { encoding: "utf8" })
    .trim()
    .split("\n");
  if (urls.length !== 1) throw new Error("Select a remote with exactly one push URL for CI setup");
  repositoryTransport(urls[0] ?? "");
  return urls[0] ?? "";
}

export const remoteRepository = (root: string, remote: string) => repositoryIdentity(remoteTransport(root, remote));

/** Match the actual push destination, so an alias moved to another server cannot reuse its old CI declaration. */
export function pushCIDestinations(root: string, remote?: string, url?: string): (CIDestination | undefined)[] {
  const destinations = readConfig(root).ci?.destinations ?? [];
  if (!destinations.length) return [undefined];
  if (!remote && !url) return destinations;
  const transport = url ?? remoteTransport(process.env.WORKBENCH_LOCAL_CONFIG_ROOT ?? root, remote ?? "");
  const key = repositoryTransport(transport);
  const exact = destinations.filter((entry) => entry.transports?.some((alias) => repositoryTransport(alias) === key));
  const selected = exact[0] ?? destinations.find((entry) => entry.repository === repositoryIdentity(transport));
  if (!selected)
    throw new Error(
      "Push destination has no CI declaration; run workbench ci setup --remote REMOTE, or configure ci.destinations explicitly",
    );
  return [selected];
}

export function ciDestination(root: string, name: string): CIDestination {
  const selected = readConfig(root).ci?.destinations?.find((entry) => entry.remote === name);
  if (!selected) throw new Error(`Unknown CI destination: ${name}`);
  return selected;
}

export function pairedRegistries(provider: CIProvider, repository: string, builders: string[], registry?: string) {
  const url = new URL(repository);
  const base =
    registry ??
    (provider === CIProvider.GitHub && url.hostname === "github.com"
      ? `ghcr.io${url.pathname}`
      : provider === CIProvider.GitLab && url.hostname === "gitlab.com"
        ? `registry.gitlab.com${url.pathname}`
        : undefined);
  if (!base && builders.length)
    throw new Error("Self-hosted CI requires --registry HOST/NAMESPACE when prepared images are configured");
  if (!base) return {};
  return Object.fromEntries(
    builders.map((builder) => [builder, `${base}/development-${builder}`.toLowerCase()]),
  ) as Partial<Record<ImageBuilder, string>>;
}
