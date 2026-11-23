import { chownSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  importManagedProfiles,
  readManagedProfileArchive,
  restoredProfileDirectory,
} from "../app/src/core/execution/environments/managed/profile-transfer.mjs";
import { record, required, strings } from "../app/src/core/runtime/values.mjs";
import { withManagedProcesses } from "./managed-process.mjs";

const file = required(process.argv[2], "Missing managed archive");
const selection = record(
  JSON.parse(required(process.argv[3], "Missing managed profile selection")),
  "Invalid selection",
);
const { builder, architecture, kind } = selection;
if (
  (builder !== "nix" && builder !== "guix") ||
  (architecture !== "x64" && architecture !== "arm64") ||
  (kind !== "toolchain" && kind !== "development")
)
  throw new Error("Invalid managed profile selection");
const roots = strings(selection.roots, "Invalid managed archive roots");
const expected = { builder, architecture, kind, roots } as const;
if (!existsSync("/.dockerenv") || process.getuid?.() !== 0 || process.arch !== architecture)
  throw new Error("Archive qualification must run in a disposable container matching its architecture");
const directory = restoredProfileDirectory;
const profiles = await readManagedProfileArchive(file, expected);
if (profiles.profiles.some(({ profile }) => existsSync(profile)))
  throw new Error("The bootstrap image already contains a selected archive profile");
mkdirSync(directory, { mode: 0o755 });
const env = { ...process.env, ...(builder === "nix" ? { NIX_REMOTE: "daemon" } : {}) };
const home = "/tmp/workbench-home";
const user = process.argv[4] ?? "1000:1000";
if (!/^[1-9]\d{0,9}:\d{1,10}$/.test(user)) throw new Error("Archive execution requires a non-root user and group");
const [uid, gid] = user.split(":").map(Number);
if (uid === undefined || gid === undefined || uid >= 0xffff_ffff || gid >= 0xffff_ffff)
  throw new Error("Invalid numeric user for archive execution");
mkdirSync(home, { mode: 0o700 });
chownSync(home, uid, gid);

await withManagedProcesses(async (scope) => {
  const command = builder === "nix" ? "nix" : "guix";
  const args =
    builder === "nix" ? ["--extra-experimental-features", "nix-command", "store", "ping"] : ["gc", "--list-roots"];
  for (let attempt = 0; ; attempt++) {
    try {
      await scope.run(command, args, { capture: true, env });
      break;
    } catch (cause) {
      if (attempt >= 59) throw new Error(`The bootstrap ${builder} daemon did not become ready`, { cause });
      await delay(250);
    }
  }
  const restored = await importManagedProfiles(file, expected, {
    env,
    guixVerifier: join(import.meta.dirname, "verify-guix-profile-archive.scm"),
  });
  if (builder === "guix") mkdirSync(join(directory, "runtimes"));
  const registered: string[] = [];
  for (const [index, entry] of restored.entries()) {
    const name = String(index);
    const path = join(directory, name);
    if (builder === "nix") {
      await scope.run(
        "nix-store",
        ["--option", "substitute", "false", "--max-jobs", "0", "--add-root", path, "--realise", entry.profile],
        { env },
      );
    } else {
      const runtime = join(directory, "runtimes", name);
      const manager = join(directory, `manager-${name}`);
      symlinkSync(entry.profile, path);
      symlinkSync(required(entry.runtime, "Missing Guix runtime"), runtime);
      symlinkSync(required(entry.manager, "Missing Guix manager"), manager);
      registered.push(path, runtime, manager);
    }
  }
  if (registered.length) {
    await scope.run(
      "guix",
      ["repl", join(import.meta.dirname, "ci-guix-bootstrap.scm"), "register-roots", ...registered],
      { env },
    );
    const listed = (await scope.run("guix", ["gc", "--list-roots"], { capture: true, env })).split(/\r?\n/);
    if (registered.some((root) => !listed.includes(root)))
      throw new Error("Guix did not retain every restored profile root");
  }
  writeFileSync(join(directory, "roots.json"), JSON.stringify(roots), { flag: "wx", mode: 0o644 });
});
