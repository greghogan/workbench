import { distributionRoot } from "./project-context.js";
import { readConfig } from "./project-configuration.js";
import { writeAtomic } from "../scripts/file-publication.mjs";
import { join } from "node:path";
import { skillCatalog, skillIdentities } from "./skill-catalog.js";
import { formatFiles } from "./formatting.js";
import { synchronize } from "./sync.js";
import { ensureLocalIgnore } from "./environments.js";
import { validate } from "./validation.js";

/** Run only in the updater's isolated checkout, using the target revision. */
export async function prepareUpdate(root: string): Promise<void> {
  readConfig(root);
  ensureLocalIgnore(root);
  await formatFiles(root, undefined, { all: true, write: true });
  synchronize(root, false);
  writeAtomic(
    join(root, "workbench/.skill-catalog.json"),
    JSON.stringify(skillIdentities(skillCatalog(distributionRoot(root)))),
  );
  await validate(root);
  console.log("Update preparation validated.");
}
