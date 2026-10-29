import { record, string } from "./values.mjs";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

/** Local CI recipe. Node is authenticated before execution. */
export function ciImageContext(
  distribution: string,
  context: string,
  image: string,
  architecture: string = process.arch,
): string {
  mkdirSync(context, { recursive: true });
  cpSync(join(distribution, "scripts/ci-linux"), context, { recursive: true });
  const node = readFileSync(join(distribution, ".node-version"), "utf8").trim();
  const inventory = record(
    JSON.parse(readFileSync(join(distribution, "scripts/native-assets.json"), "utf8")),
    "Invalid native assets",
  );
  const asset = record(
    record(record(inventory.node, "Missing Node assets")[node], "Missing pinned Node assets")[`linux-${architecture}`],
    "Missing Node platform asset",
  );
  const checksums = record(asset.checksums, "CI image requires a signed native Linux Node bootstrap");
  const signature = record(checksums.signature, "Missing Node checksum signature");
  const key = resolve(distribution, string(signature.keys, "Missing Node signing keys"));
  if (!key.startsWith(`${resolve(distribution)}/`)) throw new Error("Node bootstrap key escapes distribution");
  let component = resolve(distribution);
  for (const part of relative(component, key).split("/")) {
    component = join(component, part);
    if (lstatSync(component).isSymbolicLink()) throw new Error("Node bootstrap key must be a real distribution file");
  }
  cpSync(key, join(context, "node.asc"));
  signature.keys = "node.asc";
  writeFileSync(join(context, "bootstrap.json"), JSON.stringify(asset));
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        image,
        architecture,
        ...["Dockerfile", "bootstrap.py", "bootstrap.json", "node.asc"].map((name) =>
          readFileSync(join(context, name), "utf8"),
        ),
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  return `workbench-ci:${hash}`;
}

export function verifyCIImage(image: string, architecture: string = process.arch): void {
  const value = record(
    JSON.parse(execFileSync("docker", ["image", "inspect", "--format", "{{json .}}", image], { encoding: "utf8" })),
    "Invalid Docker image inspection",
  );
  if (value.Os !== "linux" || value.Architecture !== { x64: "amd64", arm64: "arm64" }[architecture])
    throw new Error("CI image does not match the native Linux architecture; emulation is not selected");
}
