import { required } from "../src/invariants.ts";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { copyScriptClosure } from "./fixtures/script-closure.mjs";

const repository = resolve(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-java-runner-"));
  temporary.push(root);
  for (const path of [".mvn/checksums", "src", "distribution/scripts", "distribution/bin", "clients"])
    mkdirSync(join(root, path), { recursive: true });
  cpSync(join(repository, "bundle"), join(root, "distribution/bundle"), { recursive: true });
  copyFileSync(join(repository, "bin/bundle-runtime.cjs"), join(root, "distribution/bin/bundle-runtime.cjs"));
  for (const file of ["java-check.mjs"])
    await copyScriptClosure(repository, join(root, "distribution"), `scripts/${file}`);
  writeFileSync(join(root, "pom.xml"), "fixture POM");
  writeFileSync(
    join(root, ".mvn/checksums/checksums.sha256"),
    `${"0".repeat(64)}  org/example/fixture/1/fixture-1.jar\n`,
  );
  writeFileSync(
    join(root, ".mvn/acquisition.json"),
    JSON.stringify({ resolver: "org.apache.maven.plugins:maven-dependency-plugin:3.11.0:go-offline", trust: [] }),
  );
  writeFileSync(join(root, "src/Count.java"), "class Count {}\n");
  writeFileSync(join(root, "src/Other.java"), "class Other {}\n");
  writeFileSync(join(root, "README.md"), "fixture console example");
  writeFileSync(
    join(root, "maven.cjs"),
    `const fs=require('node:fs'),p=require('node:path');
fs.appendFileSync(process.env.FIXTURE_EVENTS,JSON.stringify(process.argv.slice(2))+'\\n');
const build=process.argv.find(x=>x.startsWith('-Dworkbench.build=')).slice('-Dworkbench.build='.length);
if(process.argv.includes('compile')){
 fs.mkdirSync(p.join(build,'classes'),{recursive:true});
 fs.writeFileSync(p.join(build,'classes/Count.class'),fs.readFileSync('src/Count.java'));
}
if(process.argv.includes('fmt:format')){
 fs.writeFileSync('src/Count.java','class Count { /* formatted */ }\\n');
 if(process.env.FIXTURE_EDIT){
  const edited=process.env.FIXTURE_EDIT==='same'?'Count':'Other';
  fs.writeFileSync(p.join(process.env.FIXTURE_SOURCE,'src',edited+'.java'),'class '+edited+' { /* concurrent */ }\\n');
  fs.writeFileSync(p.join(process.env.FIXTURE_SOURCE,'src/New.java'),'class New {}\\n');
 }
}
if(process.argv.includes('test')&&process.env.FIXTURE_REPORT){
 fs.mkdirSync(p.join(build,'surefire-reports'),{recursive:true});
 fs.writeFileSync(p.join(build,'surefire-reports',process.env.FIXTURE_REPORT),'<testsuite tests="1"/>');
}
process.exit(Number(process.env.FIXTURE_EXIT||'0'));`,
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
  const run = (role: string, extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(
      process.execPath,
      [join(repository, "examples/languages/java/scripts/check.mjs"), role, join(root, "distribution")],
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
          FIXTURE_SOURCE: root,
          ...extra,
        },
      },
    );
  return { root, run };
}

test.skipIf(process.platform === "win32").each([false, true])(
  "Java documentation compiles current sources before verification; compiler failure: %s",
  async (fail) => {
    const f = await fixture();
    const result = f.run("docs", { FIXTURE_EXIT: fail ? "7" : "0" });
    const events = readFileSync(join(f.root, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(required(events[0], "Expected compiler execution").at(-1)).toBe("compile");
    if (fail) {
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/Maven docs failed.*status=7/);
      expect(result.stderr).not.toContain("file://");
      expect(Buffer.byteLength(result.stderr)).toBeLessThan(4096);
      expect(events).toHaveLength(1);
    } else {
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(events[1]).toEqual(["docs", "docs", "README.md"]);
    }
  },
);

test.skipIf(process.platform === "win32").each(["same", "other"])(
  "formatter writeback preserves a concurrent edit to the %s file",
  async (edited) => {
    const f = await fixture();
    const result = f.run("format-write", { FIXTURE_EDIT: edited });
    const count = readFileSync(join(f.root, "src/Count.java"), "utf8");
    if (edited === "same") {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("source changed during formatting");
      expect(count).toContain("concurrent");
    } else {
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(count).toContain("formatted");
      expect(readFileSync(join(f.root, "src/Other.java"), "utf8")).toContain("concurrent");
    }
    expect(readFileSync(join(f.root, "src/New.java"), "utf8")).toBe("class New {}\n");
  },
);

test.skipIf(process.platform === "win32")("a failed formatter leaves its staged changes unpublished", async () => {
  const f = await fixture();
  const result = f.run("format-write", { FIXTURE_EXIT: "7" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/Maven format-write failed.*status=7/);
  expect(readFileSync(join(f.root, "src/Count.java"), "utf8")).toBe("class Count {}\n");
});

test.skipIf(process.platform === "win32")(
  "test and qualification invocations replace reports even after failure",
  async () => {
    const f = await fixture();
    const first = f.run("test", { FIXTURE_REPORT: "OldTest.xml" });
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const reports = join(f.root, "coverage/surefire");
    expect(readdirSync(reports).filter((name) => name.endsWith(".xml"))).toEqual(["OldTest.xml"]);
    const failed = f.run("test", { FIXTURE_REPORT: "RenamedTest.xml", FIXTURE_EXIT: "7" });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toMatch(/Maven test failed.*status=7/);
    expect(readdirSync(reports).filter((name) => name.endsWith(".xml"))).toEqual(["RenamedTest.xml"]);
    expect(JSON.parse(readFileSync(join(reports, ".workbench-run.json"), "utf8"))).toMatchObject({
      outcome: "failed",
      status: 7,
    });
    const missing = f.run("dependency-verify", { FIXTURE_EXIT: "7" });
    expect(missing.status).not.toBe(0);
    expect(readdirSync(reports)).toEqual([".workbench-run.json"]);
    expect(JSON.parse(readFileSync(join(reports, ".workbench-run.json"), "utf8"))).toMatchObject({
      outcome: "missing",
      role: "dependency-verify",
    });
  },
);
