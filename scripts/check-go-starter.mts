import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const distribution = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "workbench-go-starter-"));
try {
  const project = join(temporary, "project");
  const result = spawnSync(
    process.execPath,
    [join(distribution, "bin/workbench.mjs"), "init", "--language", "go", "--no-workbench-collection", project],
    {
      env: {
        ...process.env,
        WORKBENCH_PROJECT_ROOT: project,
        WORKBENCH_DISTRIBUTION_ROOT: distribution,
        WORKBENCH_LOCAL_CONFIG_ROOT: undefined,
        WORKBENCH_EPHEMERAL_CHECKOUT: undefined,
        WORKBENCH_CONFIG_HOME: join(temporary, "config"),
        WORKBENCH_CACHE_HOME: join(temporary, "cache"),
        WORKBENCH_DATA_HOME: join(temporary, "data"),
        WORKBENCH_STATE_HOME: join(temporary, "state"),
      },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Go starter could not be initialized");
  const source = readFileSync(join(distribution, "examples/languages/go/count.go"));
  if (!readFileSync(join(project, "count.go")).equals(source))
    throw new Error("Initialized Go starter differs from the shipped implementation");
} finally {
  rmSync(temporary, { force: true, recursive: true });
}
