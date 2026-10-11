import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, createReadStream, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// This adapter publishes only already verified example images; routine CI never invokes it.
export async function verifyRegistryPublication(root, builder, environment = process.env, backend) {
  if (!["nix", "guix"].includes(builder)) throw new Error("select nix or guix publication verification");
  const repository = environment.GITHUB_REPOSITORY;
  const revision = environment.GITHUB_SHA;
  const runID = environment.GITHUB_RUN_ID;
  const attempt = environment.GITHUB_RUN_ATTEMPT;
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
    !/^[a-f0-9]{40}$/.test(revision ?? "") ||
    !/^\d+$/.test(runID ?? "") ||
    !/^\d+$/.test(attempt ?? "")
  )
    throw new Error("publication requires an explicit GitHub workflow identity");
  const profile = `go-${builder}-docker`;
  const artifact = join(root, "dist/releases", profile);
  const receipt = JSON.parse(readFileSync(join(artifact, "workbench-release.json"), "utf8"));
  if (
    receipt.version !== 1 ||
    receipt.verified !== true ||
    receipt.emulation !== false ||
    receipt.builder !== builder ||
    receipt.profile?.name !== profile ||
    receipt.source?.revision !== revision
  )
    throw new Error("publication requires the selected revision's verified native release receipt");
  const file = join(artifact, "docker.tar.gz");
  const expected = receipt.artifacts?.find((entry) => entry.path === "docker.tar.gz" && entry.type === "file");
  const info = lstatSync(file);
  if (!expected || !info.isFile() || info.isSymbolicLink() || info.size !== expected.size)
    throw new Error("publication archive differs from its verified receipt");
  const hash = createHash("sha256");
  for await (const part of createReadStream(file)) hash.update(part);
  assert.equal(hash.digest("hex"), expected.sha256, "publication archive differs from its verified receipt");
  const docker =
    backend?.docker ??
    ((...args) => {
      const result = spawnSync("docker", args, { encoding: "utf8" });
      if (result.error || result.status !== 0)
        throw result.error ?? new Error(`docker ${args[0]} failed: ${result.stderr}`);
      return result.stdout.trim();
    });
  const source = `workbench-count-${builder}:${builder === "guix" ? "latest" : "local"}`;
  const image = `ghcr.io/${repository.toLowerCase()}-ci-${builder}:ci-${runID}-${attempt}-${revision.slice(0, 12)}`;
  const present = backend?.hasImage
    ? backend.hasImage(source)
    : spawnSync("docker", ["image", "inspect", source], { stdio: "ignore" }).status === 0;
  if (present) throw new Error(`preserve existing local image: ${source}`);
  let loaded = false;
  let tagged = false;
  try {
    docker("load", "--input", file);
    loaded = true;
    const imageID = docker("image", "inspect", "--format", "{{.Id}}", source);
    assert.match(imageID, /^sha256:[a-f0-9]{64}$/);
    assert.equal(docker("run", "--rm", "--pull=never", "--network=none", source, "a", "banana"), "3");
    docker("tag", source, image);
    tagged = true;
    docker("push", image);
    const digests = JSON.parse(docker("image", "inspect", "--format", "{{json .RepoDigests}}", image));
    const digest = digests.find((value) => value.startsWith(image.split(":")[0] + "@sha256:"));
    assert.match(digest ?? "", /@sha256:[a-f0-9]{64}$/);
    // Remove the source image and tag so successful execution must use the registry pull.
    docker("image", "rm", image, source);
    tagged = false;
    loaded = false;
    docker("pull", digest);
    assert.equal(docker("image", "inspect", "--format", "{{.Id}}", digest), imageID);
    assert.equal(docker("run", "--rm", "--pull=never", "--network=none", digest, "a", "banana"), "3");
    const evidence = {
      version: 1,
      profile,
      revision,
      image,
      digest,
      imageID,
      archiveSHA256: expected.sha256,
      verified: true,
      published: true,
      deployed: false,
    };
    const output = join(environment.RUNNER_TEMP, "publication-evidence");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, `${builder}.json`), JSON.stringify(evidence, null, 2) + "\n");
    if (environment.GITHUB_STEP_SUMMARY)
      appendFileSync(
        environment.GITHUB_STEP_SUMMARY,
        `\n## Registry verification (${builder})\n\nPublished and pulled \`${digest}\`; image identity and offline behavior match the verified artifact. No deployment occurred.\n`,
      );
    console.log(JSON.stringify(evidence));
    docker("image", "rm", digest);
    return evidence;
  } finally {
    if (tagged) docker("image", "rm", image);
    if (loaded) docker("image", "rm", source);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await verifyRegistryPublication(process.cwd(), process.argv[2]);
