import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Scenario {
  requests: string[];
}
const args = process.argv.slice(2),
  scenario = JSON.parse(readFileSync(process.env.FIXTURE_SCENARIO ?? "", "utf8")) as Scenario,
  settings = readFileSync(args[args.indexOf("--settings") + 1] ?? "", "utf8"),
  base = /<url>([^<]+)<\/url>/u.exec(settings)?.[1];
assert.ok(base);
const responses: { path: string; status: number; bytes: string }[] = [];
for (const path of scenario.requests) {
  const response: Response = await fetch(base + path);
  const bytes: string = await response.text();
  responses.push({ path, status: response.status, bytes });
  if (response.ok) {
    const checksum: Response = await fetch(base + path + ".sha256");
    assert.equal(checksum.status, 200);
    assert.equal(await checksum.text(), createHash("sha256").update(bytes).digest("hex"));
  }
}
const files = readdirSync(process.cwd(), { recursive: true, encoding: "utf8" }).filter((path) =>
  statSync(join(process.cwd(), path)).isFile(),
);
// Exit successfully even on HTTP errors: the owner must detect verification failures independently.
writeFileSync(process.env.FIXTURE_HTTP_RESULT ?? "", JSON.stringify({ responses, files }));
