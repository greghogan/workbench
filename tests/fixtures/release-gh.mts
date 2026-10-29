#!/usr/bin/env node
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { required } from "../../scripts/values.mjs";
const root = required(process.env.RELEASE_FIXTURE, "Missing publication fixture");
const args = process.argv.slice(2);
appendFileSync(join(root, "events"), JSON.stringify(args.slice(0, 3)) + "\n");
const option = (name: string) => required(args[args.indexOf(name) + 1], `Missing ${name}`);
const outages = join(root, "outages.json");
if (existsSync(outages)) {
  const failures = JSON.parse(readFileSync(outages, "utf8")) as Record<string, number>;
  const category = args[0] === "api" ? "metadata" : args[1] === "download" ? "download" : "write";
  if ((failures[category] ?? 0) > 0) {
    failures[category] = (failures[category] ?? 0) - 1;
    writeFileSync(outages, JSON.stringify(failures));
    if (category === "download") {
      mkdirSync(option("--dir"), { recursive: true });
      writeFileSync(join(option("--dir"), "partial-download"), "incomplete network response");
    }
    console.error("HTTP 503 Service Unavailable");
    process.exit(1);
  }
}
if (args[1] === "download" && existsSync(join(option("--dir"), "partial-download")))
  throw new Error("A release download reused incomplete bytes from a failed attempt");
const stateFile = join(root, "state.json");
interface State {
  tag_name: string;
  target_commitish: string;
  body: string;
  draft: boolean;
  assets: { name: string }[];
}
let state: State | undefined = existsSync(stateFile)
  ? (JSON.parse(readFileSync(stateFile, "utf8")) as State)
  : undefined;
const copy = (from: string, to: string) => {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
};
if (args[0] === "api") {
  const path = required(args[1], "Missing API path");
  if (path === "graphql")
    console.log(JSON.stringify({ data: { repository: { release: state ? { databaseId: 1 } : null } } }));
  else if (path.endsWith("/releases/1")) console.log(JSON.stringify(state));
  else if (path.includes("/actions/runs/")) console.log(readFileSync(join(root, "run.json"), "utf8"));
  else if (path.includes("/releases/tags/")) {
    if (state && path.endsWith("/" + state.tag_name)) console.log(JSON.stringify(state));
    else {
      console.error("HTTP 404");
      process.exitCode = 1;
    }
  } else if (path.includes("/git/ref/tags/")) {
    if (state && !state.draft) console.log(JSON.stringify({ object: { type: "commit", sha: state.target_commitish } }));
    else {
      console.error("HTTP 404");
      process.exitCode = 1;
    }
  } else throw new Error("Unexpected API");
} else if (args[0] === "run" && args[1] === "download") {
  cpSync(join(root, option("--name")), option("--dir"), { recursive: true });
} else if (args[0] === "release") {
  const tag = required(args[2], "Missing tag");
  if (args[1] === "create") {
    if (state) throw new Error("Release exists");
    state = { tag_name: tag, target_commitish: option("--target"), body: option("--notes"), draft: true, assets: [] };
  } else {
    if (state?.tag_name !== tag) throw new Error("Missing release");
    if (args[1] === "upload") {
      const source = required(args[3], "Missing asset");
      const name = source.split(/[\\/]/).at(-1);
      if (!name || state.assets.some((asset) => asset.name === name)) throw new Error("Asset replacement is forbidden");
      copy(source, join(root, "assets", name));
      state.assets.push({ name });
    } else if (args[1] === "download") {
      for (const asset of state.assets) copy(join(root, "assets", asset.name), join(option("--dir"), asset.name));
    } else if (args[1] === "edit") state.draft = false;
    else throw new Error("Unexpected release command");
  }
  writeFileSync(stateFile, JSON.stringify(state));
} else throw new Error("Unexpected command");
