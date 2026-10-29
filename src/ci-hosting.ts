import { record, records, string, strings } from "../scripts/values.mjs";
import { imageRepository } from "./container-references.js";

export enum CIProvider {
  GitHub = "github",
  GitLab = "gitlab",
}
export type ImageBuilder = "native" | "nix" | "guix";
export interface CIDestination {
  remote: string;
  provider: CIProvider;
  repository: string;
  transports?: string[];
  registries: Partial<Record<ImageBuilder, string>>;
  runners?: Record<string, string[]>;
}
export const ciPlatforms = {
  "linux-x64": { os: "linux", architecture: "x64", github: "ubuntu-26.04" },
  "linux-arm64": { os: "linux", architecture: "arm64", github: "ubuntu-26.04-arm" },
  "macos-arm64": { os: "macos", architecture: "arm64", github: "macos-15" },
  "windows-x64": { os: "windows", architecture: "x64", github: "windows-2025" },
} as const;
export type CIPlatform = keyof typeof ciPlatforms;
export function ciPlatform(os: string, architecture: string) {
  const key = `${os}-${architecture}`;
  if (!Object.hasOwn(ciPlatforms, key)) throw new Error(`Unsupported CI platform: ${key}`);
  return ciPlatforms[key as CIPlatform];
}
export const githubRunner = (os: string, architecture: string) => ciPlatform(os, architecture).github;

/** Keep transport scheme, SSH alias and port independent of the web/API project identity. */
export function repositoryTransport(remote: string): string {
  repositoryIdentity(remote);
  const parsed = new URL(remote.replace(/^([^/@:]+@)?([^/:]+):([^/].*)$/, "ssh://$1$2/$3"));
  parsed.pathname = parsed.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "");
  return parsed.href;
}

/** Normalize Git transport URLs to a credential-free project identity, including nested GitLab namespaces. */
export function repositoryIdentity(remote: string): string {
  if (/[\s\\\p{Cc}]/u.test(remote))
    throw new Error("Git remote must be an HTTPS or SSH repository without credentials");
  let parsed: URL;
  try {
    parsed = new URL(remote.replace(/^([^/@:]+@)?([^/:]+):([^/].*)$/, "ssh://$1$2/$3"));
  } catch {
    throw new Error("Invalid HTTPS or SSH Git remote identity");
  }
  const parts = parsed.pathname
    .replace(/\.git\/?$/, "")
    .replace(/^\/|\/$/g, "")
    .split("/");
  if (
    !["https:", "ssh:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.password ||
    (parsed.protocol === "https:" && parsed.username) ||
    parsed.search ||
    parsed.hash ||
    parts.length < 2 ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || [".", ".."].includes(part))
  )
    throw new Error("Git remote must identify an HTTPS or SSH project without embedded credentials");
  const path = parts.join("/");
  return `https://${parsed.protocol === "ssh:" ? parsed.hostname : parsed.host}/${parsed.hostname === "github.com" ? path.toLowerCase() : path}`;
}

export function readCIDestinations(value: unknown): CIDestination[] {
  const destinations = records(value, "ci.destinations must be an array of tables").map((input): CIDestination => {
    if (
      Object.keys(input).some(
        (key) => !["remote", "provider", "repository", "transports", "registries", "runners"].includes(key),
      )
    )
      throw new Error("Unknown CI destination field");
    const remote = string(input.remote, "Missing CI remote");
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(remote)) throw new Error("Invalid CI remote name");
    const provider = Object.values(CIProvider).find((provider) => provider === input.provider);
    if (!provider) throw new Error("CI provider must be github or gitlab");
    const repository = repositoryIdentity(string(input.repository, "Missing CI repository"));
    if (repository !== input.repository)
      throw new Error("CI repository must use its canonical HTTPS project identity without .git");
    const transports =
      input.transports === undefined
        ? undefined
        : strings(input.transports, "Invalid CI transports").map(repositoryTransport);
    if (transports && new Set(transports).size !== transports.length) throw new Error("CI transports must be distinct");
    const registries: CIDestination["registries"] = {};
    for (const [builder, registry] of Object.entries(record(input.registries ?? {}, "Invalid CI registries"))) {
      if (!["native", "nix", "guix"].includes(builder) || typeof registry !== "string" || !imageRepository(registry))
        throw new Error("CI registries must map builders to registry repositories without a tag");
      registries[builder as ImageBuilder] = registry;
    }
    const runners =
      input.runners === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(record(input.runners, "Invalid CI runner tags")).map(([platform, tags]) => {
              if (!Object.hasOwn(ciPlatforms, platform)) throw new Error(`Unknown CI runner platform: ${platform}`);
              const names = strings(tags, "CI runner tags must be strings");
              if (!names.length || names.some((name) => !name.trim() || /[\p{Cc}]/u.test(name)))
                throw new Error("CI runner tags must be nonempty");
              return [platform, names];
            }),
          );
    return {
      remote,
      provider,
      repository,
      registries,
      ...(transports ? { transports } : {}),
      ...(runners ? { runners } : {}),
    };
  });
  if (
    new Set(destinations.map((entry) => entry.remote)).size !== destinations.length ||
    new Set(destinations.map((entry) => entry.repository)).size !== destinations.length
  )
    throw new Error("CI destinations must have distinct remotes and repositories");
  const transports = destinations.flatMap((entry) => entry.transports ?? []);
  if (new Set(transports).size !== transports.length)
    throw new Error("A Git transport must identify only one CI destination");
  for (const destination of destinations)
    for (const transport of destination.transports ?? []) {
      if (destinations.some((other) => other !== destination && other.repository === repositoryIdentity(transport)))
        throw new Error("Git transport binding conflicts with another CI project identity");
    }
  return destinations;
}
