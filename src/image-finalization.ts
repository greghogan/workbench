import { errorMessage } from "../scripts/ci-results.mjs";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CILifecycle, executeCI } from "./ci-lifecycle.js";

/** Label imported images and materialize declared files without rebuilding their closure or populating shared BuildKit cache. */
export async function finalizeImage(
  source: string,
  target: string,
  labels: Record<string, string> = {},
  files: string[] = [],
): Promise<void> {
  if (files.some((file) => !["/etc/passwd", "/etc/group"].includes(file)))
    throw new Error("Only declared container account files may be materialized");
  if (Object.keys(labels).some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)))
    throw new Error("Invalid image label name");
  const container = `workbench-finalize-${randomUUID()}`;
  const temporary = mkdtempSync(join(tmpdir(), "workbench-image-finalize-"));
  const lifecycle = new CILifecycle();
  let created = false;
  const failures: unknown[] = [];
  try {
    const config = JSON.parse(
      await executeCI("docker", ["image", "inspect", "--format", "{{json .Config}}", source], { capture: true }),
    ) as { Cmd?: string[] | null };
    await lifecycle.checkpoint();
    // Supply a command so even an image with no default command can be created; it is never started.
    await executeCI(
      "docker",
      [
        "create",
        "--name",
        container,
        ...Object.entries(labels).flatMap(([name, value]) => ["--label", `${name}=${value}`]),
        source,
        "/workbench-finalization-unused",
      ],
      { capture: true },
    );
    created = true;
    for (const file of files) {
      await lifecycle.checkpoint();
      const local = join(temporary, basename(file));
      await executeCI("docker", ["cp", "--follow-link", `${container}:${file}`, local]);
      chmodSync(local, 0o644);
      await executeCI("docker", ["cp", local, `${container}:/etc/`]);
    }
    await lifecycle.checkpoint();
    await executeCI("docker", ["commit", "--change", `CMD ${JSON.stringify(config.Cmd ?? [])}`, container, target], {
      capture: true,
    });
  } catch (error) {
    failures.push(error);
  }
  try {
    if (created) await executeCI("docker", ["rm", "--force", "--volumes", container], { capture: true });
  } catch (error) {
    failures.push(error);
  }
  lifecycle.close();
  try {
    rmSync(temporary, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(failures, failures.map(errorMessage).join("; "), { cause: failures[0] });
}
