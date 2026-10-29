import assert from "node:assert/strict";
import { validationReport } from "../src/validation.ts";
import { inspectChecks } from "../src/checks.ts";
import { startWebServer } from "../src/web/server.ts";

const kind = process.argv[2];
const root = process.cwd();
if (kind === "validation") {
  const result = await validationReport(root);
  assert.deepEqual(result.errors, [], "The profiling source must validate");
} else if (kind === "checks") {
  const result = inspectChecks(root, { stage: "commit" });
  assert.ok(result, "Check planning produced no result");
} else if (kind === "web") {
  const web = await startWebServer(root, { port: 0 });
  try {
    for (const path of ["/records", "/records?type=ADR", "/review"]) {
      const response = await fetch(web.url + path);
      assert.equal(response.status, 200, `Read-only web case ${path}`);
      assert.ok((await response.text()).length > 0);
    }
  } finally {
    await web.close();
  }
} else throw new Error("Select startup, validation, checks, or web");
