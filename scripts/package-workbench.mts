import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { candidateRevision, readCandidate } from "./ci-candidate.mts";
import { required } from "../app/src/core/runtime/values.mjs";
import { launchdNativeHelper } from "../app/src/core/distribution/launchd-paths.mts";
import { launchdHelperBytes } from "./launchd-helper.mts";
import { windowsNativeHelper, windowsServiceHelperBytes } from "./windows-service-helper.mts";
import { constants, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [option, archive, ...extra] = process.argv.slice(2);
if (option !== undefined && (option !== "--archive" || !archive || extra.length))
  throw new Error("Use package-workbench.mjs [--archive OUTPUT]");

async function deliverArchive(source: string, output: string, expected?: string): Promise<void> {
  if (output.endsWith(".zip")) {
    const { writeWorkbenchZip } = await import("./workbench-release-archive.mjs");
    const digest = expected ?? createHash("sha256").update(readFileSync(source)).digest("hex");
    await writeWorkbenchZip(source, digest, output);
  } else if (expected) {
    const payload = readFileSync(source);
    if (createHash("sha256").update(payload).digest("hex") !== expected)
      throw new Error("CI candidate archive changed during packaging");
    writeFileSync(output, payload, { flag: "wx" });
  } else copyFileSync(source, output, constants.COPYFILE_EXCL);
}

async function packageWorkbench(archive?: string): Promise<void> {
  const root = process.cwd();
  const candidate = process.env.WORKBENCH_CI_CANDIDATE;
  if (archive && candidate) {
    const repository = required(process.env.WORKBENCH_CI_REPOSITORY, "Missing candidate repository");
    const proof = readCandidate(candidate, repository, candidateRevision(root));
    const source = join(candidate, "workbench-artifacts", "workbench.tar.gz");
    await deliverArchive(source, archive, proof.sha256);
    return;
  }
  const [{ compileBundles, publishBundles }, { collectToolingArtifacts }, { verifyRuntimeDependencies }] =
    await Promise.all([
      import("./bundle-build.mjs"),
      import("./build-tooling.mts"),
      import("./runtime-dependencies.mjs"),
    ]);
  const bundles = await compileBundles(root);
  verifyRuntimeDependencies({ root, artifacts: collectToolingArtifacts(root), ...bundles });
  publishBundles(root, bundles);
  const runtime = createRequire(import.meta.url)(
    "../bundle/package.cjs",
  ) as typeof import("../app/src/core/artifacts/package.js");
  const generated: { path: string; contents: Uint8Array; executable?: true }[] = [...bundles.outputs];
  const launchd = launchdHelperBytes(root);
  if (launchd) generated.push({ path: launchdNativeHelper, contents: launchd, executable: true });
  const windows = windowsServiceHelperBytes(root);
  if (windows) generated.push({ path: windowsNativeHelper, contents: windows });
  if (!archive) await runtime.prepareWorkbenchPackage(root, { generated });
  else {
    const scratch = mkdtempSync(join(tmpdir(), "workbench-release-artifact-"));
    try {
      const packaged = await runtime.prepareWorkbenchPackage(root, { output: join(scratch, "package"), generated });
      await deliverArchive(packaged.archive, archive);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
await packageWorkbench(archive);
