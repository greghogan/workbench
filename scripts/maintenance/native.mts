import type { ToolAsset } from "../../src/tool-downloads.js";
import { basename, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { JSDOM } from "jsdom";
import { MaintenanceSources } from "./sources.mjs";
import { type Release, MaintenanceProvider, type MaintenanceEntry } from "./contract.mjs";

import { isRecord, record, records, required, string } from "../values.mjs";

/** Only acquisition fields contain substitutable versions; signer and policy metadata stay opaque. */
function recipeForVersion(value: unknown, old: string, version: string): Record<string, unknown> {
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
      recipeForVersion(recipe, old, version),
    ]),
  );
}
const hash = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Missing published SHA-256");
  return value;
};
function assetFor(release: Release, name: string) {
  return required(
    release.assets?.find((asset) => asset.name === name),
    `${release.reference}: missing asset ${name}`,
  );
}

/** Preserve every platform and authentication requirement from the selected installation recipe. */
export async function nativeMaintenanceEdits(root: string, entries: MaintenanceEntry[], sources: MaintenanceSources) {
  const path = "scripts/native-assets.json";
  const inventory = record(JSON.parse(readFileSync(join(root, path), "utf8")), "Invalid native artifact inventory");
  let changed = false;
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
          required(
            sums?.split("\n").find((line) => line.trim().endsWith(` ${filename}`)),
            `Missing Node checksum ${filename}`,
          ).split(/\s+/)[0] ?? "";
      } else if (entry.name === "java") {
        const [os, cpu] = platform.split("-");
        const architecture = cpu === "arm64" ? "aarch64" : "x64";
        const system = os === "darwin" ? "mac" : os === "win32" ? "windows" : "linux";
        const suffix = system === "windows" ? ".zip" : ".tar.gz";
        const archive = required(
          release.assets?.find(
            (asset) =>
              asset.name.startsWith(
                `OpenJDK${required(release.version.split(".")[0], "Missing JDK major")}U-jdk_${architecture}_${system}_hotspot_`,
              ) && asset.name.endsWith(suffix),
          ),
          `JDK ${release.version} is unavailable on ${platform}`,
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
          const archive = required(
            assets.find((asset) => string(asset.name, "Missing installer filename").endsWith("-x64.7z")),
            "Missing Windows Ruby archive",
          );
          const signature = required(
            assets.find((asset) => asset.name === `${string(archive.name, "Missing Ruby filename")}.asc`),
            "Missing RubyInstaller signature",
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
      if (recipe.authenticationUnavailable) {
        if (!reviewedAuthenticationSource)
          throw new Error(
            `Review renewed authentication evidence for ${entry.name}@${release.version} before selecting its native archive`,
          );
        const unavailable = record(recipe.authenticationUnavailable, "Invalid authentication exception");
        unavailable.checked = new Date().toISOString().slice(0, 10);
        unavailable.source = reviewedAuthenticationSource;
      }
    }
    versions[release.version] = replacements;
    changed = true;
  }
  const result: [string, string][] = changed ? [[path, `${JSON.stringify(inventory, null, 2)}\n`]] : [];
  const llvmPath = "scripts/llvm-assets.json";
  if (existsSync(join(root, llvmPath))) {
    const llvm = record(JSON.parse(readFileSync(join(root, llvmPath), "utf8")), "Invalid LLVM artifacts");
    let updated = false;
    for (const entry of entries) {
      if (!["llvm", "clang"].includes(entry.name) || !entry.selected || !llvm[entry.current]) continue;
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
      llvm[entry.selected.version] = recipes;
      updated = true;
    }
    if (updated) result.push([llvmPath, `${JSON.stringify(llvm, null, 2)}\n`]);
  }
  return result;
}
