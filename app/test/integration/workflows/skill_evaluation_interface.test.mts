import assert from "node:assert/strict";
import { interfaceFiles } from "../../../../scripts/skill-evaluation-interface.mjs";
import { required } from "../../../src/core/runtime/values.mjs";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { command, verifyOutcome, prepare, write } from "../../../../scripts/skill-evaluation-cases.mjs";
import { skillEvaluationFixtures } from "../../fixtures/skill-evaluation.mjs";

const fixture = skillEvaluationFixtures();

test.each(["review-interface", "task-review-interface"] as const)(
  "%s rejects passing domain tests with a broken workflow and accepts the repaired interface",
  (name) => {
    const { root, env } = fixture();
    const before = prepare(root, resolve(import.meta.dirname, "../../../.."), env, name);
    command(root, env, process.execPath, ["--test", "model.test.mjs"]);
    if (name === "task-review-interface") {
      assert.equal(command(root, env, "git", ["diff", "HEAD"]), "");
      assert.notEqual(
        command(root, env, "git", ["rev-parse", "HEAD"]),
        command(root, env, "git", ["rev-parse", "review-base"]),
      );
    }
    assert.throws(() => {
      verifyOutcome(root, env, name, before);
    }, /Queue count/);
    write(root, "views.mjs", required(interfaceFiles(false)["views.mjs"], "Missing corrected interface"));
    verifyOutcome(root, env, name, before);
    write(root, "valid-views.mjs", readFileSync(join(root, "views.mjs")));
    write(
      root,
      "views.mjs",
      `import {renderQueue, renderRequest as validRequest} from "./valid-views.mjs";
export {renderQueue};
export function renderRequest(item, mode) {
 const body = validRequest(item, mode);
 return item.status !== "approved" ? body : body.replace("</main>", '<form method="post" action="/requests/' + item.id + '/action"><button name="action" value="cancel">Cancel</button></form></main>');
}
`,
    );
    assert.throws(() => {
      verifyOutcome(root, env, name, before);
    }, /Approved request offers mutation actions/);
    write(
      root,
      "views.mjs",
      `import {renderQueue, renderRequest as validRequest} from "./valid-views.mjs";
export {renderQueue};
export function renderRequest(item, mode) { return validRequest(item, mode === "delete" ? "cancel" : mode); }
`,
    );
    assert.throws(() => {
      verifyOutcome(root, env, name, before);
    }, /Confirmation mixes unrelated actions/);
    write(root, "views.mjs", required(interfaceFiles(false)["views.mjs"], "Missing corrected interface"));
    const app = readFileSync(join(root, "app.mjs"), "utf8"),
      brokenRedirect = app.replace('location:"/"', 'location:"/missing"');
    assert.notEqual(app, brokenRedirect);
    write(root, "app.mjs", brokenRedirect);
    assert.throws(() => {
      verifyOutcome(root, env, name, before);
    }, /Interface view unavailable/);
  },
);

test("interface review preserves an already coherent workflow", () => {
  const { root, env } = fixture();
  const before = prepare(root, resolve(import.meta.dirname, "../../../.."), env, "review-interface-clean");
  write(root, "review-evidence/observations.md", "Checked the queue and confirmation workflows.\n");
  verifyOutcome(root, env, "review-interface-clean", before);
  write(root, "unnecessary.txt", "Unsupported workflow changes.\n");
  assert.throws(() => {
    verifyOutcome(root, env, "review-interface-clean", before);
  }, /coherent interface was changed/);
});
