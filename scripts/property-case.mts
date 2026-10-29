import { parseArgs } from "node:util";
import { documentProperties, isPropertyID } from "./document-properties.mjs";
import { writeAtomic } from "./file-publication.mjs";
const { values } = parseArgs({
  options: {
    property: { type: "string" },
    runs: { type: "string" },
    seed: { type: "string" },
    path: { type: "string" },
    output: { type: "string" },
  },
});
const runs = Number(values.runs),
  seed = Number(values.seed),
  id = values.property;
if (
  !id ||
  !isPropertyID(id) ||
  !values.output ||
  !Number.isSafeInteger(runs) ||
  runs < 1 ||
  runs > 1000000 ||
  !Number.isSafeInteger(seed) ||
  (values.path !== undefined && !/^(?:\d+:)*\d+$/.test(values.path))
)
  throw new Error("Invalid property worker invocation");
const outcome = documentProperties[id]({
  numRuns: runs,
  seed,
  ...(values.path === undefined ? {} : { path: values.path }),
});
writeAtomic(values.output, JSON.stringify(outcome) + "\n");
