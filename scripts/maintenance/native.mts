import type { ToolAsset } from "../../src/tool-downloads.js";
import { isDeepStrictEqual } from "node:util";
import { basename, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { JSDOM } from "jsdom";
import { MaintenanceSources } from "./sources.mjs";
import { type Release, NativeCatalog, MaintenanceProvider, type MaintenanceEntry } from "./contract.mjs";
import { phpWindowsArchive } from "./php.mjs";

import { isRecord, record, records, required, string } from "../values.mjs";

/** Only acquisition fields contain substitutable versions; signer and policy metadata stay opaque. */
function substituteRecipe(value: unknown, old: string, version: string): Record<string, unknown> {
  const recipe = structuredClone(record(value, "Invalid native recipe")) as unknown as ToolAsset & {
    name?: string;
    attestation?: ToolAsset["attestation"];
  };
  const substitute = (text: string) => text.replaceAll(old, version);
  recipe.url = substitute(string(recipe.url, "Missing archive URL"));
  if (recipe.name) recipe.name = substitute(recipe.name);
  if (recipe.backupUrls) recipe.backupUrls = recipe.backupUrls.map(substitute);
  const signature = (value: NonNullable<ToolAsset["signature"]>) => {
    value.url = substitute(value.url);
    if (value.backupUrls) value.backupUrls = value.backupUrls.map(substitute);
  };
  if (recipe.signature) signature(recipe.signature);
  if (recipe.checksums) {
    recipe.checksums.url = substitute(recipe.checksums.url);
    recipe.checksums.subject = substitute(recipe.checksums.subject);
    if (recipe.checksums.backupUrls) recipe.checksums.backupUrls = recipe.checksums.backupUrls.map(substitute);
    signature(recipe.checksums.signature);
  }
  if (recipe.attestation) {
    recipe.attestation.url = substitute(recipe.attestation.url);
    recipe.attestation.subject = substitute(recipe.attestation.subject);
    if (recipe.attestation.release) {
      const previousTag = recipe.attestation.release.tag;
      recipe.attestation.release.tag = substitute(previousTag);
      const selector = `@refs/tags/${previousTag}`;
      if (recipe.attestation.signer.endsWith(selector))
        recipe.attestation.signer =
          recipe.attestation.signer.slice(0, -selector.length) + `@refs/tags/${recipe.attestation.release.tag}`;
    } else {
      const suffix = `@refs/tags/v${old}`;
      if (recipe.attestation.signer.endsWith(suffix))
        recipe.attestation.signer = recipe.attestation.signer.slice(0, -suffix.length) + `@refs/tags/v${version}`;
    }
  }
  if (recipe.filter) recipe.filter.required = recipe.filter.required.map(substitute);

  return recipe as unknown as Record<string, unknown>;
}
function platformRecipes(value: unknown, old: string, version: string) {
  return Object.fromEntries(
    Object.entries(record(value, "Invalid platform recipes")).map(([platform, recipe]) => [
      platform,
      substituteRecipe(recipe, old, version),
    ]),
  );
}
const hash = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Missing published SHA-256");
  return value;
};
export function uniqueAsset<T>(assets: readonly T[], matches: (asset: T) => boolean, description: string): T {
  const candidates = assets.filter(matches);
  if (candidates.length > 1) throw new Error(`Ambiguous published artifact: ${description}`);
  return required(candidates[0], `Missing published artifact: ${description}`);
}
function assetFor(release: Release, name: string) {
  return uniqueAsset(release.assets ?? [], (asset) => asset.name === name, `${release.reference}: ${name}`);
}
export type NativeCatalogs = ReadonlyMap<NativeCatalog, Record<string, unknown>>;
export interface ResolvedNativeArtifact {
  catalog: NativeCatalog;
  tool: string;
  version: string;
  platform: string;
  recipe: Record<string, unknown>;
}
/** One local catalog snapshot per discovery/apply phase. Resolution never mutates it. */
export function readNativeCatalogs(root: string): NativeCatalogs {
  return new Map(
    Object.values(NativeCatalog).flatMap((path) =>
      existsSync(join(root, path))
        ? [
            [
              path,
              record(JSON.parse(readFileSync(join(root, path), "utf8")), "Invalid native artifact inventory"),
            ] as const,
          ]
        : [],
    ),
  );
}

/** Resolve replacement recipes once, preserving every platform and authentication requirement. */
export async function resolveNativeArtifacts(
  catalogs: NativeCatalogs,
  entries: MaintenanceEntry[],
  sources: MaintenanceSources,
): Promise<ResolvedNativeArtifact[]> {
  const inventory = catalogs.get(NativeCatalog.Tools) ?? {};
  const result: ResolvedNativeArtifact[] = [];
  const completed = new Set<string>();
  for (const entry of entries) {
    if (
      entry.provider !== MaintenanceProvider.Tool ||
      !entry.selected ||
      completed.has(`${entry.name}:${entry.current}`)
    )
      continue;
    completed.add(`${entry.name}:${entry.current}`);
    const versions = inventory[entry.name];
    if (!isRecord(versions) || !versions[entry.current]) continue; // Manager-owned toolchains have their own verification.
    const release = entry.selected;
    const previous = record(versions[entry.current], "Missing old native installation recipes");
    const replacements = platformRecipes(previous, entry.current, release.version);
    let sums: string | undefined;
    if (entry.name === "node")
      sums = await sources.request(`https://nodejs.org/dist/v${release.version}/SHASUMS256.txt`, "text/plain");
    for (const [platform, value] of Object.entries(replacements)) {
      const recipe = record(value, "Invalid native installation recipe");
      const before = record(previous[platform], "Missing prior platform recipe");
      let checksum: string;
      let reviewedAuthenticationSource: string | undefined;
      if (entry.name === "node") {
        const filename = basename(new URL(string(recipe.url, "Missing Node archive URL")).pathname);
        checksum =
          uniqueAsset(
            (sums ?? "").split("\n"),
            (line) => line.trim().endsWith(` ${filename}`),
            `Node checksum ${filename}`,
          )
            .trim()
            .split(/\s+/)[0] ?? "";
      } else if (entry.name === "java") {
        const [os, cpu] = platform.split("-");
        const architecture = cpu === "arm64" ? "aarch64" : "x64";
        const system = os === "darwin" ? "mac" : os === "win32" ? "windows" : "linux";
        const suffix = system === "windows" ? ".zip" : ".tar.gz";
        const archive = uniqueAsset(
          release.assets ?? [],
          (asset) =>
            asset.name.startsWith(
              `OpenJDK${required(release.version.split(".")[0], "Missing JDK major")}U-jdk_${architecture}_${system}_hotspot_`,
            ) && asset.name.endsWith(suffix),
          `JDK ${release.version} on ${platform}`,
        );
        const signature = assetFor(release, `${archive.name}.sig`);
        recipe.url = string(archive.url, "Missing JDK archive URL");
        record(recipe.signature, "JDK recipe requires a detached signature").url = string(
          signature.url,
          "Missing JDK signature URL",
        );
        checksum = hash(archive.sha256);
      } else if (entry.name === "ruby") {
        if (platform === "win32-x64") {
          const releases = records(
            await sources.json("https://api.github.com/repos/oneclick/rubyinstaller2/releases?per_page=30"),
            "Invalid RubyInstaller releases",
          );
          const installer = required(
            releases.find(
              (item) =>
                item.prerelease !== true &&
                string(item.tag_name, "Missing RubyInstaller tag").startsWith(`RubyInstaller-${release.version}-`),
            ),
            `RubyInstaller ${release.version} is unavailable`,
          );
          const assets = records(installer.assets, "Missing RubyInstaller assets");
          const archive = uniqueAsset(
            assets,
            (asset) => string(asset.name, "Missing installer filename").endsWith("-x64.7z"),
            "Windows Ruby archive",
          );
          const signature = uniqueAsset(
            assets,
            (asset) => asset.name === `${string(archive.name, "Missing Ruby filename")}.asc`,
            "RubyInstaller signature",
          );
          recipe.url = string(archive.browser_download_url, "Missing RubyInstaller URL");
          record(recipe.signature, "RubyInstaller signature required").url = string(
            signature.browser_download_url,
            "Missing signature URL",
          );
          checksum = string(archive.digest, "Missing RubyInstaller digest").replace(/^sha256:/, "");
        } else {
          const url = "https://raw.githubusercontent.com/ruby/www.ruby-lang.org/master/_data/releases.yml";
          const releases = records(
            parse(await sources.request(url, "text/plain")) as unknown,
            "Invalid Ruby source index",
          );
          const ruby = required(
            releases.find((item) => item.version === release.version),
            "Missing Ruby source release",
          );
          recipe.url = string(record(ruby.url, "Missing Ruby source URLs").gz, "Missing Ruby source archive");
          checksum = hash(record(ruby.sha256, "Missing Ruby digests").gz);
          if (recipe.authenticationUnavailable) {
            const post = new URL(string(ruby.post, "Missing Ruby release announcement"), "https://www.ruby-lang.org");
            if (post.origin !== "https://www.ruby-lang.org")
              throw new Error("Ruby authentication evidence must use the official release announcement");
            const dom = new JSDOM(await sources.request(post.href, "text/html"));
            try {
              if (!dom.window.document.documentElement.textContent.toLowerCase().includes(checksum))
                throw new Error("Ruby release announcement does not confirm the selected digest");
              const evidence = [...dom.window.document.querySelectorAll("a[href]")].some((link) =>
                /sigstore|attestation|pgp|signature|\.(?:asc|sig)(?:\?|$)/i.test(link.getAttribute("href") ?? ""),
              );
              if (evidence)
                throw new Error(
                  "Ruby release announcement provides authentication evidence; configure and verify it before selecting this archive",
                );
              reviewedAuthenticationSource = post.href;
            } finally {
              dom.window.close();
            }
          }
        }
      } else if (entry.name === "php" && platform === "win32-x64") {
        const filename = basename(new URL(string(recipe.url, "Missing Windows PHP archive URL")).pathname);
        const archive = await phpWindowsArchive(release.version, string(before.url, "Missing PHP URL"), sources);
        Object.assign(recipe, substituteRecipe(recipe, filename, archive.filename));
        checksum = archive.sha256;
        reviewedAuthenticationSource = archive.source;
      } else {
        const filename = basename(new URL(string(recipe.url, "Missing native archive URL")).pathname);
        checksum = hash(assetFor(release, filename).sha256);
      }
      recipe.sha256 = hash(checksum);
      if (recipe.attestation) {
        const attestation = record(recipe.attestation, "Invalid attestation");
        attestation.url = string(attestation.url, "Missing attestation URL").replace(
          string(before.sha256, "Missing prior digest"),
          checksum,
        );
      }
      if (
        recipe.authenticationUnavailable &&
        (release.version !== entry.current || recipe.url !== before.url || recipe.sha256 !== before.sha256)
      ) {
        if (!reviewedAuthenticationSource)
          throw new Error(
            `Review renewed authentication evidence for ${entry.name}@${release.version} before selecting its native archive`,
          );
        const unavailable = record(recipe.authenticationUnavailable, "Invalid authentication exception");
        unavailable.checked = new Date().toISOString().slice(0, 10);
        unavailable.source = reviewedAuthenticationSource;
      }
    }
    for (const [platform, recipe] of Object.entries(replacements))
      result.push({ catalog: NativeCatalog.Tools, tool: entry.name, version: release.version, platform, recipe });
  }
  const llvm = catalogs.get(NativeCatalog.LLVM);
  if (llvm) {
    for (const entry of entries) {
      if (
        entry.provider !== MaintenanceProvider.Tool ||
        !["llvm", "clang"].includes(entry.name) ||
        !entry.selected ||
        !llvm[entry.current]
      )
        continue;
      const recipes = Object.fromEntries(
        Object.entries(record(llvm[entry.current], "Invalid LLVM recipes")).map(([platform, value]) => {
          const recipe = record(structuredClone(value), "Invalid LLVM recipe");
          recipe.name = string(recipe.name, "Missing LLVM name").replaceAll(
            entry.current,
            required(entry.selected, "Missing LLVM release").version,
          );
          if (typeof recipe.attestation === "string")
            recipe.attestation = recipe.attestation.replace(
              `@refs/tags/llvmorg-${entry.current}`,
              `@refs/tags/llvmorg-${required(entry.selected, "Missing LLVM release").version}`,
            );
          return [platform, recipe];
        }),
      );
      for (const value of Object.values(recipes)) {
        const recipe = record(value, "Invalid LLVM archive");
        recipe.sha256 = hash(assetFor(entry.selected, string(recipe.name, "Missing LLVM filename")).sha256);
      }
      for (const [platform, recipe] of Object.entries(recipes))
        result.push({ catalog: NativeCatalog.LLVM, tool: "llvm", version: entry.selected.version, platform, recipe });
    }
  }
  return result;
}

/** Pure rendering: no metadata requests or filesystem reads after the selected identities are verified. */
export function renderNativeArtifacts(
  catalogs: NativeCatalogs,
  artifacts: readonly ResolvedNativeArtifact[],
): [string, string][] {
  const documents = new Map<NativeCatalog, Record<string, unknown>>();
  const selected = new Map<string, Record<string, unknown>>();
  for (const artifact of artifacts) {
    const key = JSON.stringify([artifact.catalog, artifact.tool, artifact.version, artifact.platform]);
    const previous = selected.get(key);
    if (previous && !isDeepStrictEqual(previous, artifact.recipe))
      throw new Error(`Conflicting native recipes: ${key}`);
    selected.set(key, artifact.recipe);
    const document =
      documents.get(artifact.catalog) ??
      structuredClone(required(catalogs.get(artifact.catalog), "Missing native catalog"));
    documents.set(artifact.catalog, document);
    const versions =
      artifact.catalog === NativeCatalog.Tools ? record(document[artifact.tool], "Missing native tool") : document;
    const platforms = record(versions[artifact.version] ?? {}, "Invalid native platforms");
    platforms[artifact.platform] = structuredClone(artifact.recipe);
    versions[artifact.version] = platforms;
  }
  return [...documents].map(([path, document]) => [path, `${JSON.stringify(document, null, 2)}\n`]);
}
export async function nativeMaintenanceEdits(root: string, entries: MaintenanceEntry[], sources: MaintenanceSources) {
  const catalogs = readNativeCatalogs(root);
  return renderNativeArtifacts(catalogs, await resolveNativeArtifacts(catalogs, entries, sources));
}
