import { configFromData, languageRootsFromData } from "../src/core.ts";
import { required } from "../src/invariants.ts";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { parse } from "smol-toml";

const repository = resolve(import.meta.dirname, "..");
test("every example declares both managed release builders and source-owned behavioral verification", () => {
  const projects = parse(readFileSync(join(repository, "workbench/projects.toml"), "utf8"));
  const config = configFromData(
    parse(readFileSync(join(repository, "workbench/config.toml"), "utf8")),
    undefined,
    "fixture",
  );
  for (const root of languageRootsFromData(projects, "fixture").filter(({ path }) => path !== ".")) {
    expect(readFileSync(join(repository, root.path, "LICENSE"))).toEqual(readFileSync(join(repository, "LICENSE")));
    for (const profile of required(
      required(config.development, "Expected fixture value: config.development").profiles,
      "Expected fixture value",
    ).filter((profile) => profile.offline)) {
      const names =
        profile.builder === "nix"
          ? ["package.nix"]
          : profile.builder === "guix"
            ? ["package.scm", "guix-toolchain.scm"]
            : [];
      for (const name of names) {
        const authority = join(root.path, name).split("\\").join("/");
        if (existsSync(join(repository, authority)))
          expect(required(profile.offline, "Expected fixture value").inputs).toContain(authority);
      }
    }
    for (const builder of ["nix", "guix"]) {
      expect(
        required(
          required(config.release, "Expected fixture value: config.release").profiles,
          "Expected fixture value",
        ).some((profile) => profile.path === root.path && profile.builder === builder),
      ).toBe(true);
    }
    if (root.language === "go") continue;
    const check = JSON.parse(readFileSync(join(repository, root.path, "managed-release-check.json"), "utf8")) as {
      image: string;
      site?: string;
      commands?: { stdout?: string; status?: number }[];
    };
    expect(check.image).toMatch(/@sha256:[a-f0-9]{64}$/);
    if (check.site) expect(check.site).toBe("share/site");
    else {
      expect(required(check.commands, "Expected fixture value").length).toBeGreaterThan(0);
      expect(
        required(check.commands, "Expected fixture value").every(
          (command) => command.stdout !== undefined || command.status !== undefined,
        ),
      ).toBe(true);
    }
  }
});

test.skipIf(process.platform !== "linux")(
  "managed release preparation and offline verification preserve artifacts and reject altered contracts",
  () => {
    const root = mkdtempSync(join(tmpdir(), "workbench-managed-contract-"));
    const source = join(root, "source"),
      output = join(root, "artifacts"),
      commands = join(root, "commands");
    const image = `fixture/image@sha256:${"a".repeat(64)}`;
    const packagePath = `/nix/store/${"a".repeat(32)}-application`;
    const check = {
      image,
      commands: [
        { argv: ["{bin}/count", "a", "banana"], stdout: "3\n" },
        { argv: ["{bin}/count", "a", ""], stdout: "0\n" },
        { argv: ["{bin}/count", "invalid", "banana"], status: 2 },
      ],
    };
    try {
      for (const path of [source, output, commands]) mkdirSync(path);
      writeFileSync(join(source, "managed-release-check.json"), JSON.stringify(check));
      writeFileSync(join(commands, "nix"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(commands, "nix"), 0o755);
      const docker = join(commands, "docker");
      writeFileSync(
        docker,
        `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path'); const args=process.argv.slice(2);
fs.appendFileSync(process.env.CALLS,JSON.stringify(args)+'\\n');
if(args[0]==='run') {
  for(const [name,bytes] of Object.entries({'package-path.txt':process.env.PACKAGE,'store-paths.txt':process.env.PACKAGE,'closure.nar':'fixture closure'})) fs.writeFileSync(path.join(process.env.OUTPUT,name),bytes);
} else if(args.includes('--import')) { if(fs.readFileSync(0,'utf8')!=='fixture closure') process.exit(5); }
else if(args[0]==='exec' && args.includes('--workdir')) {
  if(args.includes('invalid')) process.exit(2);
  process.stdout.write(process.env.BAD_RESULT ? '999\\n' : args.at(-1)==='' ? '0\\n' : '3\\n');
}
`,
      );
      chmodSync(docker, 0o755);
      const env = {
        ...process.env,
        PATH: `${commands}:${dirname(process.execPath)}:${String(process.env.PATH)}`,
        WORKBENCH_CI_DOCKER: docker,
        WORKBENCH_RELEASE_OUTPUT: output,
        WORKBENCH_CPUS: "2",
        OUTPUT: output,
        PACKAGE: packagePath,
        CALLS: join(root, "calls.jsonl"),
      };
      const run = (script: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}) =>
        spawnSync(process.execPath, [join(repository, "scripts", script), ...args], {
          cwd: source,
          env: { ...env, ...extra },
          encoding: "utf8",
        });
      const prepared = run("package-managed.mjs", ["nix", image]);
      expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
      const metadata = JSON.parse(readFileSync(join(output, "managed-release.json"), "utf8")) as {
        check: typeof check;
      };
      expect(metadata).toEqual({ version: 1, builder: "nix", package: packagePath, check });
      expect(existsSync(join(output, "package-path.txt"))).toBe(false);
      const verify = () => run("verify-managed.mjs", [output, source, image, "nix"]);
      const verified = verify();
      expect(verified.status, verified.stdout + verified.stderr).toBe(0);
      const calls = () =>
        readFileSync(env.CALLS, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]);
      const creation = calls().find((args) => args[0] === "create");
      expect(creation).toContain("--network=none");
      expect(
        required(creation, "Expected fixture value").filter((value: string) => value.startsWith("type=bind")),
      ).toEqual([`type=bind,src=${output},dst=/artifacts,readonly`]);
      expect(readFileSync(join(output, "closure.nar"), "utf8")).toBe("fixture closure");
      const failed = run("verify-managed.mjs", [output, source, image, "nix"], { BAD_RESULT: "1" });
      expect(failed.status).not.toBe(0);
      expect(required(calls().at(-1), "Expected fixture value").slice(0, 2)).toEqual(["rm", "--force"]);
      const before = calls().length;
      required(metadata.check.commands[0], "Expected fixture value").stdout = "999\n";
      writeFileSync(join(output, "managed-release.json"), JSON.stringify(metadata));
      const changed = verify();
      expect(changed.status).not.toBe(0);
      expect(changed.stderr).toContain("source-owned verification contract");
      expect(calls()).toHaveLength(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
