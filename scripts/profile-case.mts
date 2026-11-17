import assert from "node:assert/strict";
import { validationReport } from "../app/src/core/records/validation.ts";
import { inspectChecks } from "../app/src/core/execution/checks/checks.ts";
import { startWebServer } from "../app/src/server/http/server.ts";
import { ReviewInventory } from "../app/src/server/projects/review-inventory.ts";

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
    for (const path of ["/records", "/records?type=ADR", "/plans", "/work", "/reviews"]) {
      const response = await fetch(web.url + path);
      assert.equal(response.status, 200, `Read-only web case ${path}`);
      assert.ok((await response.text()).length > 0);
    }
  } finally {
    await web.close();
  }
} else if (kind === "reviews") {
  const reader = new ReviewInventory(root);
  for (const state of ["cold", "warm", "warm"]) {
    const started = performance.now();
    const result = await reader.collect();
    console.log(
      JSON.stringify({
        state,
        count: result.count,
        inputs: result.inputs.size,
        durationMs: performance.now() - started,
      }),
    );
  }
} else throw new Error("Select startup, validation, checks, web, or reviews");
