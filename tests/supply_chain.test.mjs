import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, test, vi } from "vitest";
import { checkAdvisories, lockedQueries } from "../src/advisories.ts";
import { checkSecrets } from "../src/secrets.ts";
const roots = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-supply-"));
  roots.push(root);
  return root;
}

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
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ results: [{}, {}] })));
  await checkAdvisories(root, "typescript");
  vi.stubGlobal(
    "fetch",
    async () => new Response(JSON.stringify({ results: [{}, { vulns: [{ id: "TEST-ADVISORY" }] }] })),
  );
  await assert.rejects(checkAdvisories(root, "typescript"), /transitive.*TEST-ADVISORY/);
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ results: [{}, { next_page_token: "more" }] })));
  await assert.rejects(checkAdvisories(root, "typescript"), /incomplete results/);
  vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(checkAdvisories(root, "typescript"), /HTTP 503/);
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

test("credential diagnostics identify source locations without exposing values", () => {
  const root = fixture();
  const token = "ghp_" + "a".repeat(36);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/config.js"), `const token = "${token}";\n`);
  assert.throws(
    () => checkSecrets(root),
    (error) => {
      assert.match(error.message, /src[/\\]config.js:1/);
      assert.ok(!error.message.includes(token));
      return true;
    },
  );
  writeFileSync(join(root, "src/config.js"), "const token = process.env.TOKEN;\n");
  checkSecrets(root);
  writeFileSync(join(root, "private.pem"), ["-----BEGIN", "PRIVATE KEY-----"].join(" "));
  assert.throws(() => checkSecrets(root), /private.pem:1/);
});
