import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const event = { target: process.env.WORKBENCH_CI_TARGET, command: args[0], environment: process.env.CHECK_ENVIRONMENT };
appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify(event) + "\n");
if (args[0] === "checks" && args[1] === "run") {
  if (readFileSync("draft", "utf8") !== "pending input") throw new Error("check did not receive the pending snapshot");
  const coverage = join(process.cwd(), "coverage");
  mkdirSync(coverage, { recursive: true });
  writeFileSync(join(coverage, "fixture.json"), JSON.stringify(event));
  if (process.env.FIXTURE_BEHAVIOR === "managed-failure" && event.environment === "guix") process.exitCode = 2;
  if (process.env.FIXTURE_BEHAVIOR === "target-failure" && event.target === "native") process.exitCode = 2;
} else if (args[0] !== "tools" || args[1] !== "install")
  throw new Error(`Unsupported fixture Workbench command: ${args.join(" ")}`);
