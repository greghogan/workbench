import { readConfig } from "./core.js";
import { formatFiles } from "./formatting.js";
import { synchronize } from "./sync.js";
import { ensureLocalIgnore } from "./environments.js";
import { validate } from "./validation.js";

/** Run only in the updater's isolated checkout, using the target revision. */
export async function prepareUpdate(root: string): Promise<void> {
  readConfig(root);
  ensureLocalIgnore(root);
  await formatFiles(root, undefined, { all: true, write: true });
  synchronize(root);
  await validate(root);
  console.log("Update preparation validated.");
}
