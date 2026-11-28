import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const distribution = resolve(import.meta.dirname, "..");
const linux = process.platform === "linux";
const operatingSystem = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
const target = `${operatingSystem}-${process.arch}`;
const bootstrap = process.argv[2];
if (linux && !bootstrap) throw new Error("Supply the pinned Linux bootstrap image for this qualification");
if (!["linux-x64", "linux-arm64", "macos-arm64", "windows-x64"].includes(target))
  throw new Error(`No native archive qualification for ${target}`);

const temporary = realpathSync(mkdtempSync(join(tmpdir(), "workbench-archive-check-")));
const builder = join(temporary, "builder");
const receiver = join(temporary, "receiver");
const transfers = join(temporary, "transfers");
const example = join(distribution, "examples/languages/go/.go-version");
const version = readFileSync(example, "utf8").trim();
const cli = join(distribution, "bin/workbench.mjs");

function run(project: string, args: string[], offline = false): string {
  const storage = `${project}-cache`;
  return execFileSync(process.execPath, [cli, "--plain", ...args], {
    cwd: project,
    env: {
      ...process.env,
      WORKBENCH_PROJECT_ROOT: project,
      WORKBENCH_DISTRIBUTION_ROOT: distribution,
      WORKBENCH_LOCAL_CONFIG_ROOT: project,
      WORKBENCH_STORAGE_ROOT: storage,
      WORKBENCH_STORAGE_EXTERNAL: "true",
      WORKBENCH_CACHE_HOME: storage,
      WORKBENCH_CONFIG_HOME: `${project}-config`,
      WORKBENCH_STATE_HOME: `${project}-state`,
      WORKBENCH_DATA_HOME: `${project}-data`,
      WORKBENCH_OFFLINE: offline ? "1" : "0",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 180_000,
  });
}

try {
  mkdirSync(join(builder, "workbench"), { recursive: true });
  copyFileSync(example, join(builder, ".go-version"));
  writeFileSync(join(builder, "go.mod"), "module workbench.example/archive\n\ngo 1.24\n");
  writeFileSync(
    join(builder, "workbench/config.toml"),
    "schema_version=1\n[markdown]\nwrap_width=120\n[compatibility]\nrequired=false\n",
  );
  writeFileSync(join(builder, "workbench/CHARTER.md"), "# Charter\n\nNative archive qualification.\n");
  writeFileSync(
    join(builder, "workbench/projects.toml"),
    '[[project]]\nid="archive-check"\npath="."\n\n[[language_root]]\npath="."\nlanguage="go"\n',
  );
  writeFileSync(
    join(builder, "workbench/profiles.toml"),
    `schema_version = 1

[targets.host]
platform = "${target}"

[recipes.tools]
owner = "archive-check"
native_profile = "prepared-go"
${linux ? `bootstrap_image = ${JSON.stringify(bootstrap)}\n` : ""}
[profiles.portable-go]
builder = "native"
projects = ["archive-check"]
variants = [{ target = "host", kind = "toolchain", recipe = "tools", formats = ["archive"] }]

[[development.profiles]]
name = "prepared-go"
builder = "native"
workspace = "host"
container_config = "container.json"
[development.profiles.offline]
kind = "toolchain"
registry = "ghcr.io/workbench-test/archive-check"
inputs = [".go-version"]
`,
  );
  writeFileSync(join(builder, "container.json"), "{}\n");
  cpSync(builder, receiver, { recursive: true });
  for (const project of [builder, receiver]) {
    execFileSync("git", ["init", "-q"], { cwd: project });
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: project });
    execFileSync("git", ["config", "core.longpaths", "true"], { cwd: project });
    execFileSync("git", ["add", "."], { cwd: project });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Archive Test",
        "-c",
        "user.email=archive@example.invalid",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-qm",
        "Archive qualification inputs",
      ],
      { cwd: project },
    );
    run(project, ["project", "add", project]);
  }
  const selection = ["--kind", "toolchain", "--format", "archive"];
  console.log("Build and export the pinned Go toolchain.");
  run(builder, ["artifact", "build", "portable-go", ...selection, "--export", transfers]);
  const [generation] = readdirSync(transfers);
  assert(generation, "Missing exported native archive");
  const archive = join(transfers, generation, `artifact.${linux ? "tar.gz" : "zip"}`);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(archive)) digest.update(chunk as Buffer);
  console.log("Verify the standalone archive in a separate empty cache.");
  run(receiver, ["artifact", "import", "portable-go", archive, ...selection, "--sha256", digest.digest("hex")], true);
  console.log("Run the restored Go toolchain in an offline shell.");
  const output = run(
    receiver,
    ["shell", "--artifact", "portable-go", "--kind", "toolchain", "--", "go", "env", "-json", "GOVERSION", "GOROOT"],
    true,
  );
  const result = JSON.parse(output.slice(output.indexOf("{"))) as { GOVERSION: string; GOROOT: string };
  assert.equal(result.GOVERSION, `go${version}`);
  const installed = relative(realpathSync.native(`${receiver}-cache`), realpathSync.native(result.GOROOT));
  assert(
    installed && !isAbsolute(installed) && !installed.startsWith(".."),
    "Go was installed from the receiving cache",
  );
  console.log(`Verified standalone ${target} toolchain import and offline Go activation in a fresh cache.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
