import { promised } from "./fixtures/promised.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, test, vi } from "vitest";
import { checkAdvisories, lockedQueries } from "../src/advisories.ts";
import { checkSecrets } from "../src/secrets.ts";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-supply-"));
  roots.push(root);
  return root;
}

test("advisory failures explain the locked package, impact, fixes and source without terminal injection", async () => {
  const root = fixture();
  writeFileSync(join(root, "pnpm-lock.yaml"), 'packages:\n  "zod@4.6.5": {}\n');
  const id = "GHSA-mrhx-c7xc-m3w5";
  vi.stubGlobal("fetch", (url: string) =>
    promised(
      () =>
        new Response(
          JSON.stringify(
            url.endsWith("querybatch")
              ? { results: [{ vulns: [{ id }] }] }
              : {
                  id,
                  summary: "Memory exhaustion\u001b[2J\nfrom large collections",
                  database_specific: { severity: "HIGH" },
                  affected: [
                    { package: { name: "other", ecosystem: "npm" }, ranges: [{ events: [{ fixed: "99.0.0" }] }] },
                    {
                      package: { name: "zod", ecosystem: "npm" },
                      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.6.6" }] }],
                    },
                  ],
                },
          ),
        ),
    ),
  );
  await assert.rejects(checkAdvisories(root, "typescript"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /zod@4\.6\.5 \(npm\): GHSA-mrhx-c7xc-m3w5/);
    assert.match(error.message, /Memory exhaustion from large collections/);
    assert.match(error.message, /Severity: HIGH/);
    assert.match(error.message, /Fixed release boundaries reported: 4\.6\.6/);
    assert.match(error.message, /https:\/\/github.com\/advisories\/GHSA-mrhx-c7xc-m3w5/);
    assert.doesNotMatch(error.message, /99\.0\.0/);
    assert.ok(!error.message.includes("\u001b"));
    return true;
  });
});

test("unavailable advisory details preserve the primary finding and a useful link", async () => {
  const root = fixture();
  writeFileSync(join(root, "pnpm-lock.yaml"), 'packages:\n  "package@1.2.3": {}\n');
  vi.stubGlobal("fetch", (url: string) =>
    promised(() =>
      url.endsWith("querybatch")
        ? new Response(JSON.stringify({ results: [{ vulns: [{ id: "CVE-2026-1234" }] }] }))
        : new Response("unavailable", { status: 503 }),
    ),
  );
  await assert.rejects(
    checkAdvisories(root, "typescript"),
    /package@1\.2\.3[\s\S]*details unavailable[\s\S]*https:\/\/osv\.dev\/vulnerability\/CVE-2026-1234/,
  );
});

test("advisory checks include transitive locks and fail closed on findings or incomplete responses", async () => {
  const root = fixture();
  writeFileSync(
    join(root, "pnpm-lock.yaml"),
    'packages:\n  "@scope/direct@1.2.3": {}\n---\npackages:\n  "transitive@2.3.4": {}\n',
  );
  assert.deepEqual(lockedQueries(root, "typescript"), [
    { package: { name: "@scope/direct", ecosystem: "npm" }, version: "1.2.3" },
    { package: { name: "transitive", ecosystem: "npm" }, version: "2.3.4" },
  ]);
  vi.stubGlobal("fetch", () => promised(() => new Response(JSON.stringify({ results: [{}, {}] }))));
  await checkAdvisories(root, "typescript");
  vi.stubGlobal("fetch", () =>
    promised(() => new Response(JSON.stringify({ results: [{}, { vulns: [{ id: "TEST-ADVISORY" }] }] }))),
  );
  await assert.rejects(checkAdvisories(root, "typescript"), /transitive.*TEST-ADVISORY/);
  vi.stubGlobal("fetch", () =>
    promised(() => new Response(JSON.stringify({ results: [{}, { next_page_token: "more" }] }))),
  );
  await assert.rejects(checkAdvisories(root, "typescript"), /incomplete results/);
  vi.stubGlobal("fetch", () => promised(() => new Response("unavailable", { status: 503 })));
  await assert.rejects(checkAdvisories(root, "typescript"), /HTTP 503/);
});

test.each([
  null,
  { results: [0] },
  { results: [false] },
  { results: ["unavailable"] },
  { results: [[]] },
  { results: [null] },
  { results: [{ vulns: null }] },
  { results: [{ vulns: "" }] },
  { results: [{ vulns: [null] }] },
  { results: [{ vulns: [{}] }] },
  { results: [{ vulns: [{ id: 123 }] }] },
  { results: [{ vulns: [{ id: " " }] }] },
  { results: [{ next_page_token: 0 }] },
])("malformed advisory response %j cannot establish a clean dependency gate", async (data) => {
  const root = fixture();
  writeFileSync(join(root, "pnpm-lock.yaml"), 'packages:\n  "package@1.2.3": {}\n');
  vi.stubGlobal("fetch", () => promised(() => new Response(JSON.stringify(data))));
  await assert.rejects(checkAdvisories(root, "typescript"), /invalid advisory response/);
});

test("Go advisories inspect acquired archives rather than unused graph metadata", () => {
  const root = fixture();
  writeFileSync(
    join(root, "go.sum"),
    [
      "example.org/used v1.2.3 h1:archive",
      "example.org/used v1.2.3/go.mod h1:metadata",
      "example.org/unused v0.1.0/go.mod h1:metadata",
    ].join("\n"),
  );
  assert.deepEqual(lockedQueries(root, "go"), [
    { package: { name: "example.org/used", ecosystem: "Go" }, version: "v1.2.3" },
  ]);
});

test("isolated npm bootstrap dependencies remain covered by advisory inspection", () => {
  const root = fixture();
  writeFileSync(join(root, "pnpm-lock.yaml"), "packages: {}\n");
  for (const name of ["package-manager", "container-tools"]) {
    const path = join(root, "scripts", name);
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "package-lock.json"),
      JSON.stringify({
        packages: {
          "": {},
          "node_modules/@devcontainers/cli": { version: "0.89.0" },
        },
      }),
    );
  }
  assert.deepEqual(lockedQueries(root, "typescript"), [
    { package: { name: "@devcontainers/cli", ecosystem: "npm" }, version: "0.89.0" },
  ]);
});

test("credential diagnostics identify source locations without exposing values", () => {
  const root = fixture();
  const token = "ghp_" + "a".repeat(36);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/config.js"), `const token = "${token}";\n`);
  assert.throws(
    () => {
      checkSecrets(root);
    },
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /src[/\\]config.js:1/);
      assert.ok(!error.message.includes(token));
      return true;
    },
  );
  writeFileSync(join(root, "src/config.js"), "const token = process.env.TOKEN;\n");
  mkdirSync(join(root, "vendor/dependency"), { recursive: true });
  writeFileSync(join(root, "vendor/dependency/fixture.pem"), ["-----BEGIN", "PRIVATE KEY-----"].join(" "));
  checkSecrets(root);
  writeFileSync(join(root, "private.pem"), ["-----BEGIN", "PRIVATE KEY-----"].join(" "));
  assert.throws(() => {
    checkSecrets(root);
  }, /private.pem:1/);
});

test("advisory detail requests are shared across locked versions only within the invocation", async () => {
  const root = fixture();
  writeFileSync(join(root, "pnpm-lock.yaml"), 'packages:\n  "package@1.0.0": {}\n  "package@2.0.0": {}\n');
  let details = 0;
  vi.stubGlobal("fetch", (url: string) =>
    promised(() => {
      if (url.endsWith("querybatch"))
        return new Response(JSON.stringify({ results: [{ vulns: [{ id: "TEST" }] }, { vulns: [{ id: "TEST" }] }] }));
      details++;
      return new Response(JSON.stringify({ id: "TEST", summary: "Affects both versions" }));
    }),
  );
  await assert.rejects(checkAdvisories(root, "typescript"), /package@1\.0\.0[\s\S]*package@2\.0\.0/);
  assert.equal(details, 1);
  await assert.rejects(checkAdvisories(root, "typescript"));
  assert.equal(details, 2);
});
