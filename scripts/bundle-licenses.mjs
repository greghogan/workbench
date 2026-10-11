import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse } from "smol-toml";
import { dirname, join, resolve, sep } from "node:path";

/** Retain the notices shipped with every package actually included by esbuild. */
export function bundleLicenses(root, inputs) {
  const policy = parse(readFileSync(join(root, "workbench/config.toml"), "utf8")).licenses;
  if (!Array.isArray(policy?.allow) || !policy.allow.length)
    throw new Error("configure licenses.allow before bundling dependencies");
  const packages = new Map();
  const overridesPath = join(root, "scripts/bundle-license-overrides.json");
  const overrides = existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, "utf8")) : {};
  for (const input of inputs) {
    if (!input.split(/[\\/]/).includes("node_modules")) continue;
    let directory = dirname(resolve(root, input));
    while (!existsSync(join(directory, "package.json"))) {
      const parent = dirname(directory);
      if (parent === directory) throw new Error(`cannot identify bundled package: ${input}`);
      directory = parent;
    }
    const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const identity = `${metadata.name}@${metadata.version}`;
    if (packages.has(identity)) continue;
    if (!policy.allow.includes(metadata.license))
      throw new Error(`${identity}: license '${metadata.license}' needs policy review`);
    const license = ["LICENSE", "LICENSE.md", "LICENSE.txt"].find((file) => existsSync(join(directory, file)));
    const override = overrides[identity];
    if (!license && !override) throw new Error(`${identity}: identify its license notice before bundling`);
    const notice = readFileSync(license ? join(directory, license) : join(root, override.path), "utf8");
    if (!license && createHash("sha256").update(notice).digest("hex") !== override.sha256)
      throw new Error(`${identity}: retained upstream license checksum mismatch`);
    packages.set(identity, notice.trimEnd());
  }
  return [...packages]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([identity, notice]) => `${identity}\n${"=".repeat(identity.length)}\n\n${notice}\n`)
    .join("\n");
}

export const noticesPath = ["bundle", "THIRD_PARTY_NOTICES.txt"].join(sep);
