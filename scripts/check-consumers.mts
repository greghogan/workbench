import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { isCompilerFamily } from "./compiler-catalog.mjs";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      artifacts: { type: "string" },
      output: { type: "string" },
      language: { type: "string", multiple: true },
      compiler: { type: "string", multiple: true },
      "cold-cache": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help)
    console.log(
      "Usage: node scripts/check-consumers.mjs [--artifacts DIRECTORY] [--output NEW_DIRECTORY] [--language ID ...] [--compiler clang|gcc|mvsc] [--cold-cache]",
    );
  else {
    const runtime = createRequire(import.meta.url)("../bundle/consumer.cjs") as typeof import("../src/consumer.js");
    if (values.compiler?.some((value) => !isCompilerFamily(value)))
      throw new Error("Select integration compiler clang, gcc, or mvsc");
    await runtime.runConsumerIntegration({
      ...(values.artifacts === undefined ? {} : { artifacts: values.artifacts }),
      ...(values.output === undefined ? {} : { output: values.output }),
      ...(values.language === undefined ? {} : { languages: values.language }),
      ...(values.compiler === undefined ? {} : { compilers: values.compiler.filter(isCompilerFamily) }),
      coldCache: values["cold-cache"] === true,
    });
  }
}
await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Consumer integration failed; see retained reports");
  process.exitCode = 1;
});
