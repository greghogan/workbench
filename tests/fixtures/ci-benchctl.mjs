#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Exercise the real forwarded CLI through the hold/follow protocol, without global scheduler state.
const args = process.argv.slice(2);
const state = process.env.FIXTURE_SCHEDULER_STATE;
appendFileSync(`${state}.events`, `${args[0]}\n`);
if (args[0] === "hold") {
  const separator = args.indexOf("--");
  if (separator < 0) throw new Error("scheduler fixture requires a command");
  const command = args.slice(separator + 1);
  const result = spawnSync(command[0], command.slice(1), { env: process.env, encoding: "utf8" });
  if (result.error) throw result.error;
  writeFileSync(state, JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));
  console.log("abc123");
} else if (args[0] === "follow" && args.at(-1) === "abc123") {
  const result = JSON.parse(readFileSync(state, "utf8"));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
} else throw new Error("unsupported scheduler fixture operation");
