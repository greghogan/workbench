// Generated from check.mts; edit the TypeScript source.
import { spawnSync } from "node:child_process";
const manager = process.env.npm_execpath;
if (!manager) throw new Error("Invoke checks through the declared package manager");
for (const role of ["format:check", "lint", "typecheck", "test"]) {
  const command = /\.[cm]?js$/i.test(manager) ? [process.execPath, manager] : [manager];
  const result = spawnSync(command[0], [...command.slice(1), "run", role], { stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`${role} failed: ${String(result.error ?? result.status)}`);
}
