import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

/** Local CI recipe. Node is authenticated before execution. */
export function ciImageContext(distribution, context, image, architecture = process.arch) {
  mkdirSync(context, { recursive: true });
  cpSync(join(distribution, "scripts/ci-linux"), context, { recursive: true });
  const node = readFileSync(join(distribution, ".node-version"), "utf8").trim();
  const asset = JSON.parse(readFileSync(join(distribution, "scripts/native-assets.json"), "utf8")).node?.[node]?.[
    `linux-${architecture}`
  ];
  if (!asset?.checksums) throw new Error("CI image requires a signed native Linux Node bootstrap");
  const key = resolve(distribution, asset.checksums.signature.keys);
  if (!key.startsWith(`${resolve(distribution)}/`)) throw new Error("Node bootstrap key escapes distribution");
  let component = resolve(distribution);
  for (const part of relative(component, key).split("/")) {
    component = join(component, part);
    if (lstatSync(component).isSymbolicLink()) throw new Error("Node bootstrap key must be a real distribution file");
  }
  cpSync(key, join(context, "node.asc"));
  asset.checksums.signature.keys = "node.asc";
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

export function verifyCIImage(image, architecture = process.arch) {
  const value = JSON.parse(
    execFileSync("docker", ["image", "inspect", "--format", "{{json .}}", image], { encoding: "utf8" }),
  );
  if (value.Os !== "linux" || value.Architecture !== { x64: "amd64", arm64: "arm64" }[architecture])
    throw new Error("CI image does not match the native Linux architecture; emulation is not selected");
}
