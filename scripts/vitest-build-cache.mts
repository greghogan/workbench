import { acquireBuildUse, buildPaths, prepareBuild } from "../app/src/core/artifacts/builds.ts";
export { checkTestTimings, copyCheckTestTimings } from "../app/src/core/execution/checks/check-test-timings.ts";

export function prepareVitestCache(root: string): string {
  const paths = buildPaths(root, root, "native");
  const owner = acquireBuildUse(paths);
  try {
    prepareBuild(paths);
  } catch (error) {
    owner.release();
    throw error;
  }
  process.once("exit", () => {
    owner.release();
  });
  return paths.directory;
}
