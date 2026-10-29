import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { compare } from "semver";
import { withEngineeringRun } from "../scripts/engineering-run.mjs";
import { mavenChecksums, verifyMavenArtifact } from "./maven-artifacts.js";
import { required } from "./invariants.js";
import { nativeEnvironment } from "./native-tools.js";
import { withToolCacheUseAsync } from "./tool-cache-lock.js";
import { decodeMavenAuthentication } from "./maven-policy.js";

/** Exercise a real direct/transitive runtime closure using artifacts already pinned by the starter. */
export async function verifyJavaConsumerDistribution(distribution: string): Promise<void> {
  await withEngineeringRun(tmpdir(), "java-consumer", async (run) => {
    const project = join(run.directory, "project");
    cpSync(join(distribution, "examples/languages/java"), project, {
      recursive: true,
      filter: (path) => !/(?:^|[/\\])(?:build|target|dist|coverage|node_modules)(?:[/\\]|$)/.test(path),
    });
    const pom = join(project, "pom.xml"),
      source = join(project, "src/main/java/org/example/workbench/Count.java");
    const originalPom = readFileSync(pom, "utf8"),
      originalSource = readFileSync(source, "utf8");
    const checksums = mavenChecksums(readFileSync(join(project, ".mvn/checksums/checksums.sha256"), "utf8"));
    const version = (artifact: string) =>
      required(
        [...checksums.keys()]
          .flatMap((path) => {
            const match = new RegExp(`^org/apache/commons/${artifact}/([^/]+)/${artifact}-\\1\\.jar$`).exec(path);
            return match?.[1] ? [match[1]] : [];
          })
          .sort(compare)
          .at(-1),
        `Pinned ${artifact} runtime fixture`,
      );
    const textVersion = version("commons-text"),
      langVersion = version("commons-lang3");
    const dependency = (artifact: string, selected: string) =>
      `<dependency><groupId>org.apache.commons</groupId><artifactId>${artifact}</artifactId><version>${selected}</version></dependency>`;
    assert.ok(originalPom.includes("</properties>") && originalPom.includes("<dependencies>"));
    assert.equal(originalSource.split("args[1].getBytes").length, 2);
    // Select a reviewed transitive version; do not introduce a second set of fixture dependency pins.
    writeFileSync(
      pom,
      originalPom
        .replace("<dependencies>", `<dependencies>${dependency("commons-text", textVersion)}`)
        .replace(
          "</properties>",
          `</properties><dependencyManagement><dependencies>${dependency("commons-lang3", langVersion)}</dependencies></dependencyManagement>`,
        ),
    );
    writeFileSync(
      source,
      originalSource.replace(
        "args[1].getBytes",
        "org.apache.commons.text.StringEscapeUtils.escapeJson(args[1]).getBytes",
      ),
    );
    const output = join(run.directory, "dist");
    const env = { ...process.env, WORKBENCH_BUILD_DIR: join(run.directory, "build"), WORKBENCH_RELEASE_OUTPUT: output };
    const release = () =>
      run.run(process.execPath, [join(project, "scripts/check.mjs"), "release", distribution], { cwd: project, env });
    const verify = () =>
      run.run(process.execPath, [join(project, "scripts/release-verify.mjs"), output, project, distribution], {
        cwd: run.directory,
        env,
      });
    await release();
    await verify();
    const library = join(
      output,
      `count/lib/org/apache/commons/commons-lang3/${langVersion}/commons-lang3-${langVersion}.jar`,
    );
    assert.ok(existsSync(library), "The application must include its transitive dependency");
    const held = readFileSync(library);
    rmSync(library);
    const broken = await run.command("java", ["-jar", join(output, "count/count.jar"), "97", "banana"], {
      cwd: run.directory,
      env,
    });
    assert.notEqual(broken.status, 0, "Consumer execution must detect a missing transitive dependency");
    assert.match(broken.stderr, /NoClassDefFoundError/);
    writeFileSync(library, held);
    writeFileSync(pom, originalPom);
    writeFileSync(source, originalSource);
    await release();
    assert.equal(
      existsSync(join(output, "count/lib")),
      false,
      "Removed dependencies must leave the application distribution",
    );
    await verify();
    writeFileSync(join(project, ".mvn/runtime.json"), '{"kind":"library"}\n');
    await release();
    assert.equal(
      existsSync(join(output, "count/run")),
      false,
      "Thin libraries must not advertise an application launcher",
    );
    await verify();
    console.log(
      "Verified Java direct/transitive runtime closure, independent consumer execution, missing-library failure, and dependency removal.",
    );
  });
  await verifyJavaWorkspaceConsumerDistribution(distribution);
}

/** Current sibling sources must win over cached artifacts without changing the external dependency lock. */
export async function verifyJavaWorkspaceConsumerDistribution(
  distribution: string,
  options: { acquire?: boolean } = {},
): Promise<void> {
  await withToolCacheUseAsync(() =>
    withEngineeringRun(tmpdir(), "java-source-consumer", async (run) => {
      const root = join(run.directory, "workspace"),
        application = join(root, "application"),
        library = join(root, "library"),
        leaf = join(root, "leaf"),
        repository = join(run.directory, "maven");
      const starter = join(distribution, "examples/languages/java");
      const modules = [application, library, leaf];
      for (const target of modules)
        cpSync(starter, target, {
          recursive: true,
          filter: (path) => !/(?:^|[/\\])(?:build|target|dist|coverage|node_modules)(?:[/\\]|$)/.test(path),
        });
      mkdirSync(join(root, "workbench"));
      writeFileSync(join(root, "workbench/projects.toml"), '[[project]]\nid="java-workspace-fixture"\npath="."\n');
      const pom = readFileSync(join(application, "pom.xml"), "utf8"),
        artifact = "workbench-source-fixture",
        leafArtifact = "workbench-leaf-fixture";
      assert.ok(pom.includes("<artifactId>java-reference</artifactId>") && pom.includes("<dependencies>"));
      const dependency = (name: string) =>
        `<dependency><groupId>org.example.workbench</groupId><artifactId>${name}</artifactId><version>0.1.0</version></dependency>`;
      const providerPom = (name: string, finalName: string) =>
        pom
          .replace("<artifactId>java-reference</artifactId>", `<artifactId>${name}</artifactId>`)
          .replace("<finalName>count</finalName>", `<finalName>${finalName}</finalName>`)
          .replace(
            "<workbench.application>true</workbench.application>",
            "<workbench.application>false</workbench.application>",
          )
          .replace(/<mainClass>[^<]+<\/mainClass>/u, "");
      const libraryPom = providerPom(artifact, "library").replace(
        "<dependencies>",
        `<dependencies>${dependency(leafArtifact)}`,
      );
      writeFileSync(join(library, "pom.xml"), libraryPom);
      writeFileSync(join(leaf, "pom.xml"), providerPom(leafArtifact, "leaf"));
      for (const target of [library, leaf]) {
        writeFileSync(join(target, ".mvn/runtime.json"), '{"kind":"library"}\n');
        rmSync(join(target, "src"), { recursive: true });
      }
      const source = join(leaf, "src/main/java/org/example/shared/Values.java"),
        intermediate = join(library, "src/main/java/org/example/shared/Input.java");
      for (const target of [source, intermediate]) mkdirSync(dirname(target), { recursive: true });
      const implementation = `package org.example.shared;

public final class Values {
  private Values() {}

  public static String text(String value) {
    return value;
  }
}
`;
      writeFileSync(source, implementation);
      writeFileSync(
        intermediate,
        implementation.replaceAll("Values", "Input").replace("return value;", "return Values.text(value);"),
      );
      for (const [module, name] of [
        [library, "Input"],
        [leaf, "Values"],
      ] as const) {
        const tests = join(module, "src/test/java/org/example/shared");
        mkdirSync(tests, { recursive: true });
        writeFileSync(
          join(tests, `${name}Test.java`),
          `package org.example.shared;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

final class ${name}Test {
  @Test
  void preservesTextAcrossTheSourceBoundary() {
    for (String value : new String[] {"", "banana", "文"}) {
      assertEquals(value, ${name}.text(value));
    }
  }
}
`,
        );
      }
      writeFileSync(
        join(application, "pom.xml"),
        pom.replace("<dependencies>", `<dependencies>${dependency(artifact)}`),
      );
      const acquisitionFile = join(application, ".mvn/acquisition.json");
      const acquisition = JSON.parse(readFileSync(acquisitionFile, "utf8")) as Record<string, unknown>;
      writeFileSync(acquisitionFile, JSON.stringify({ ...acquisition, sources: ["../library", "../leaf"] }) + "\n");
      const main = join(application, "src/main/java/org/example/workbench/Count.java");
      writeFileSync(
        main,
        readFileSync(main, "utf8").replace("args[1].getBytes", "org.example.shared.Input.text(args[1]).getBytes"),
      );
      const checksumBytes = readFileSync(join(application, ".mvn/checksums/checksums.sha256"));
      const checksums = mavenChecksums(checksumBytes.toString("utf8"));
      let expectedConsumerChecksums = checksumBytes;
      const sharedRepository = options.acquire
        ? undefined
        : required(process.env.WORKBENCH_MAVEN_REPOSITORY, "Java integration needs its prepared Maven repository");
      for (const path of sharedRepository ? checksums.keys() : []) {
        const target = join(repository, path);
        mkdirSync(dirname(target), { recursive: true });
        await verifyMavenArtifact(required(sharedRepository, "Frozen Maven repository"), path, checksums, target);
      }
      const localPrefix = `org/example/workbench/${artifact}/0.1.0/${artifact}-0.1.0`;
      const leafPrefix = `org/example/workbench/${leafArtifact}/0.1.0/${leafArtifact}-0.1.0`;
      assert.equal(
        sharedRepository ? existsSync(join(sharedRepository, `${localPrefix}.jar`)) : false,
        false,
        "Source artifacts must not enter the shared repository",
      );
      const stale = join(repository, `${localPrefix}.jar`);
      mkdirSync(dirname(stale), { recursive: true });
      writeFileSync(stale, "Stale source artifact must never be loaded");
      writeFileSync(join(repository, `${localPrefix}.pom`), libraryPom);
      const output = join(run.directory, "dist");
      if (options.acquire) {
        writeFileSync(
          join(root, "workbench/config.toml"),
          `schema_version=1
[checks]
environment="native"
[markdown]
wrap_width=120
[compatibility]
required=false
data="delete"
`,
        );
        writeFileSync(
          join(root, "workbench/projects.toml"),
          `[[project]]
id="java-acquisition-fixture"
path="."
[[language_root]]
language="java"
path="application"
`,
        );
      }
      const env = {
        ...(options.acquire ? nativeEnvironment(application, distribution) : process.env),
        WORKBENCH_DISTRIBUTION_ROOT: distribution,
        WORKBENCH_DATA_HOME: join(run.directory, "data"),
        WORKBENCH_STATE_HOME: join(run.directory, "state"),
        WORKBENCH_PROJECT_ROOT: root,
        WORKBENCH_EPHEMERAL_CHECKOUT: "1",
        WORKBENCH_BUILD_DIR: join(run.directory, "build"),
        WORKBENCH_RELEASE_OUTPUT: output,
        WORKBENCH_MAVEN_REPOSITORY: repository,
      };
      if (options.acquire) {
        const cli = join(distribution, "bin/workbench.mjs"),
          proposal = join(run.directory, "proposal"),
          poms = modules.map((module) => [join(module, "pom.xml"), readFileSync(join(module, "pom.xml"))] as const);
        // Prepare genuinely cold external inputs; stale source files in the private repository remain ignored.
        await run.run(process.execPath, [cli, "project", "add", root], { cwd: root, env });
        await run.run(
          process.execPath,
          [cli, "tools", "maven", "prepare", "--path", "application", "--output", proposal],
          { cwd: root, env },
        );
        const authentication = decodeMavenAuthentication(
          JSON.parse(readFileSync(join(proposal, "authentication.json"), "utf8")),
        );
        assert.ok(authentication.artifacts.length > 0, "Cold preparation must produce authenticated external inputs");
        assert.ok(
          authentication.artifacts.every(
            (input) =>
              !input.path.startsWith(localPrefix.slice(0, localPrefix.lastIndexOf("/") + 1)) &&
              !input.path.startsWith(leafPrefix.slice(0, leafPrefix.lastIndexOf("/") + 1)),
          ),
          "Source outputs must not become external inputs",
        );
        const leafPom = join(leaf, "pom.xml"),
          prior = readFileSync(leafPom);
        writeFileSync(leafPom, Buffer.concat([prior, Buffer.from("\n")]));
        const stale = await run.command(
          process.execPath,
          [cli, "tools", "maven", "accept", "--path", "application", "--proposal", proposal],
          { cwd: root, env, capture: true },
        );
        assert.notEqual(stale.status, 0, "A provider edit must invalidate the acquisition proposal");
        assert.match(stale.stderr, /stale|changed/iu);
        writeFileSync(leafPom, prior);
        await run.run(
          process.execPath,
          [cli, "tools", "maven", "accept", "--path", "application", "--proposal", proposal],
          { cwd: root, env },
        );
        expectedConsumerChecksums = readFileSync(join(application, ".mvn/checksums/checksums.sha256"));
        rmSync(proposal, { recursive: true });
        await run.run(process.execPath, [join(application, "scripts/check.mjs"), "format-write", distribution], {
          cwd: application,
          env,
        });
        await run.run(process.execPath, [join(application, "scripts/check.mjs"), "dependency-verify", distribution], {
          cwd: application,
          env,
        });
        for (const [path, bytes] of poms)
          assert.deepEqual(readFileSync(path), bytes, "Qualification must preserve source POMs");
      }
      const command = [join(application, "scripts/check.mjs"), "release", distribution];
      const packaged = join(output, "count/count.jar");
      const execute = () => run.run("java", ["-jar", packaged, "97", "banana"], { cwd: run.directory, env });
      await run.run(process.execPath, command, { cwd: application, env });
      assert.equal((await execute()).trim(), "3");
      const copiedLibrary = join(output, `count/lib/${localPrefix}.jar`);
      assert.ok(existsSync(copiedLibrary), "The distribution must include the source-built library");
      const copiedLeaf = join(output, `count/lib/${leafPrefix}.jar`);
      assert.ok(existsSync(copiedLeaf), "The distribution must include its transitive source-built library");
      const firstLibrary = readFileSync(copiedLeaf);
      writeFileSync(source, implementation.replace("return value;", 'return value + "a";'));
      await run.run(process.execPath, command, { cwd: application, env });
      assert.equal((await execute()).trim(), "4", "Unchanged coordinates must still consume changed sibling sources");
      assert.notDeepEqual(readFileSync(copiedLeaf), firstLibrary);
      assert.equal(readFileSync(stale, "utf8"), "Stale source artifact must never be loaded");
      assert.equal(sharedRepository ? existsSync(join(sharedRepository, `${localPrefix}.jar`)) : false, false);
      assert.equal(sharedRepository ? existsSync(join(sharedRepository, `${leafPrefix}.jar`)) : false, false);
      for (const module of modules)
        assert.deepEqual(
          readFileSync(join(module, ".mvn/checksums/checksums.sha256")),
          module === application ? expectedConsumerChecksums : checksumBytes,
        );
      const compiler = required(
        [...checksums].find(([path]) => path.includes("/maven-compiler-plugin/") && path.endsWith(".jar")),
        "Frozen compiler plugin fixture",
      );
      for (const module of modules)
        writeFileSync(
          join(module, ".mvn/checksums/checksums.sha256"),
          checksumBytes.toString("utf8").replace(`${compiler[1]}  ${compiler[0]}`, `${"0".repeat(64)}  ${compiler[0]}`),
        );
      const prior = readFileSync(packaged);
      const failed = await run.command(process.execPath, command, { cwd: application, env, capture: true });
      assert.notEqual(failed.status, 0, "A wrong external plugin checksum must remain fatal");
      assert.match(failed.stdout + failed.stderr, /checksum/iu);
      assert.deepEqual(readFileSync(packaged), prior, "A failed build must preserve its prior published output");
      console.log(
        "Verified Java sibling-source changes, stale-cache isolation, runtime packaging, and frozen plugin verification.",
      );
    }),
  );
}
