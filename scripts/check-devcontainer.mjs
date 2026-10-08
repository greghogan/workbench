import { spawnSync } from "node:child_process";

const roots = JSON.parse(process.env.CHECK_ROOTS ?? "[]");
if (!Array.isArray(roots) || !roots.length || roots.some((path) => typeof path !== "string" || !path))
  throw new Error("CHECK_ROOTS must contain selected CI root paths");
for (const path of roots) {
  const result = spawnSync(
    process.execPath,
    ["bin/workbench.mjs", "checks", "run", "--stage", "ci", "--environment", "devcontainer", "--path", path],
    { stdio: "inherit" },
  );
  if (result.error || result.status !== 0) throw new Error(`Dev Container checks failed in ${path}`);
}
