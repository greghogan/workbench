import { required } from "../src/invariants.ts";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expect, test } from "vitest";

const repository = resolve(import.meta.dirname, "..");

test.skipIf(process.platform === "win32").each([false, true])(
  "Java documentation compiles current sources before verification; compiler failure: %s",
  (fail) => {
    const root = mkdtempSync(join(tmpdir(), "workbench-java-docs-"));
    try {
      for (const path of [".mvn/checksums", "src", "distribution/scripts", "distribution/bin", "clients"])
        mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, "pom.xml"), "fixture POM");
      writeFileSync(join(root, ".mvn/checksums/checksums.sha256"), "fixture checksums");
      writeFileSync(join(root, "src/Count.java"), "current source");
      writeFileSync(join(root, "README.md"), "fixture console example");
      for (const file of ["cpu-budget.mjs", "java-coverage.mjs", "values.mjs"])
        copyFileSync(join(repository, "scripts", file), join(root, "distribution/scripts", file));
      writeFileSync(
        join(root, "maven.cjs"),
        `const fs=require('node:fs'),p=require('node:path');
fs.appendFileSync(process.env.FIXTURE_EVENTS,JSON.stringify(process.argv.slice(2))+'\\n');
if(process.env.FIXTURE_COMPILER_FAIL==='1')process.exit(7);
if(!process.argv.includes('compile'))throw Error('documentation must compile first');
const build=process.argv.find(x=>x.startsWith('-Dworkbench.build=')).slice('-Dworkbench.build='.length);
fs.mkdirSync(p.join(build,'classes'),{recursive:true});
fs.writeFileSync(p.join(build,'classes/Count.class'),fs.readFileSync('src/Count.java'));`,
      );
      writeFileSync(join(root, "clients/mvn"), '#!/bin/sh\nexec "$FIXTURE_NODE" "$FIXTURE_MAVEN" "$@"\n', {
        mode: 0o700,
      });
      writeFileSync(
        join(root, "distribution/bin/workbench.mjs"),
        `import {appendFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';
if(readFileSync(join(process.env.WORKBENCH_BUILD_DIR,'java/target/classes/Count.class'),'utf8')!==readFileSync('src/Count.java','utf8'))throw Error('documentation used stale classes');
appendFileSync(process.env.FIXTURE_EVENTS,JSON.stringify(['docs',...process.argv.slice(2)])+'\\n');`,
      );
      const result = spawnSync(
        process.execPath,
        [join(repository, "examples/languages/java/scripts/check.mjs"), "docs", join(root, "distribution")],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: join(root, "clients") + delimiter + (process.env.PATH ?? ""),
            WORKBENCH_BUILD_DIR: join(root, "build"),
            WORKBENCH_MAVEN_REPOSITORY: join(root, "repository"),
            FIXTURE_NODE: process.execPath,
            FIXTURE_MAVEN: join(root, "maven.cjs"),
            FIXTURE_EVENTS: join(root, "events.jsonl"),
            FIXTURE_COMPILER_FAIL: fail ? "1" : "0",
          },
        },
      );
      const events = readFileSync(join(root, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(required(events[0], "Expected fixture value").at(-1)).toBe("compile");
      if (fail) {
        expect(result.status).not.toBe(0);
        expect(result.stdout + result.stderr).toContain("Maven docs failed (exit 7)");
        expect(events).toHaveLength(1);
      } else {
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(events[1]).toEqual(["docs", "docs", "README.md"]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
