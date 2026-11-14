import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { record, string } from "../app/src/core/runtime/values.mjs";

const request =
  "Review and finish the request-review feature against README.md, including its running interface. Fix in-scope issues.";
export const interfaceCases = {
  "review-interface": {
    skill: "review-changes",
    request,
    review:
      "Did the agent discover and repair the workflow and presentation defects despite passing domain tests, inspect the running interface, and report actual observations and limits?",
  },
  "task-review-interface": {
    skill: "review-changes",
    request:
      "Review and finish the accumulated request-review feature since the review-base tag against README.md, including its running interface. Fix in-scope issues across the feature, not only pending changes.",
    review:
      "Did task review assess the delivered workflow and repair defects already committed in the feature, rather than treating an empty pending diff or passing domain tests as completion?",
  },
  "review-interface-clean": {
    skill: "review-changes",
    request,
    review:
      "Did the agent verify the coherent workflow and report its evidence without inventing defects or making unnecessary changes?",
  },
};
export type InterfaceCase = keyof typeof interfaceCases;
export const isInterfaceCase = (name: string): name is InterfaceCase => Object.hasOwn(interfaceCases, name);
export const interfaceEvidenceDirectory = "review-evidence";

const model = `export const requests = [
  {id: "alpha", title: "Add a reading lamp", status: "pending"},
  {id: "beta", title: "Repair the desk", status: "pending"},
  {id: "gamma", title: "Replace the shelf", status: "approved"},
];
export const pendingRequests = (items) => items.filter((item) => item.status === "pending");
export const actionsFor = (item) => item.status === "pending" ? ["approve", "cancel", "delete"] : [];
export function applyAction(items, id, action, reason = "") {
  const item = items.find((item) => item.id === id);
  if (!item || !actionsFor(item).includes(action)) throw new Error("Action unavailable");
  if (action === "delete") return items.filter((item) => item.id !== id);
  return items.map((item) => item.id !== id ? item : {...item,
    status: action === "approve" ? "approved" : "canceled", ...(reason.trim() ? {reason: reason.trim()} : {})});
}
`;
const modelTests = `import {test} from "node:test";
import assert from "node:assert/strict";
import {requests, pendingRequests, actionsFor, applyAction} from "./model.mjs";
test("queue membership, approval, cancellation, and deletion", () => {
  assert.deepEqual(pendingRequests(requests).map((item) => item.id), ["alpha", "beta"]);
  assert.deepEqual(actionsFor(requests[2]), []);
  assert.equal(applyAction(requests, "alpha", "approve")[0].status, "approved");
  assert.equal(applyAction(requests, "alpha", "cancel", "Keep the account")[0].reason, "Keep the account");
  assert.equal(applyAction(requests, "alpha", "delete").length, 2);
  assert.throws(() => applyAction(requests, "gamma", "cancel"), /unavailable/);
});
`;
const sharedViews = `import {pendingRequests} from "./model.mjs";
const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const frame = (body) => '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Request review</title><style>body{font:1rem/1.5 system-ui;max-width:48rem;margin:2rem auto;padding:1rem}button,a{margin:.5rem}textarea{display:block;width:100%}</style><main>' + body + '</main></html>';
const change = (item, action, fields = "") => '<form method="post" action="/requests/' + item.id + '/action">' + fields + '<button name="action" value="' + action + '">' + action + '</button></form>';
const back = (item) => '<a href="/requests/' + item.id + '">Back to request</a>';
const reason = '<label for="reason">Reason (optional)</label><textarea id="reason" name="reason" rows="3"></textarea>';
`;
function views(broken: boolean): string {
  return (
    sharedViews +
    `export function renderQueue(items) {
  const pending = ${broken ? "items" : "pendingRequests(items)"};
  return frame('<h1>Pending requests</h1><p role="status">' + pending.length + ' pending requests</p><ul>' + pending.map((item) => '<li><a href="/requests/' + item.id + '">' + escape(item.title) + '</a></li>').join("") + '</ul>');
}
export function renderRequest(item, mode = "read") {
  const body = '<h1>' + escape(item.title) + '</h1><p>' + escape(item.status) + '</p>' + (item.reason ? '<p>' + escape(item.reason) + '</p>' : "");
  ${
    broken
      ? `return frame(body + '<form method="post" action="/requests/' + item.id + '/action"><label for="reason">Reason</label><textarea id="reason" name="reason" style="min-height:55vh" required></textarea>' + ["approve", "cancel", "delete"].map((action) => '<button name="action" value="' + action + '">' + action + '</button>').join("") + '</form><a href="/">Queue</a>');`
      : `if (item.status !== "pending") return frame(body + '<a href="/">Queue</a>');
  if (mode === "cancel") return frame(body + change(item, "cancel", reason) + back(item));
  if (mode === "delete") return frame(body + change(item, "delete") + back(item));
  return frame(body + change(item, "approve") + '<a href="/requests/' + item.id + '?mode=cancel">Cancel request…</a><a href="/requests/' + item.id + '?mode=delete">Delete request…</a><a href="/">Queue</a>');`
  }
}
`
  );
}
export const interfacePackage = {
  name: "request-review",
  private: true,
  type: "module",
  scripts: { test: "node --test", serve: "node preview.mjs" },
};
export function interfaceFiles(broken: boolean): Record<string, string> {
  return {
    "README.md": `# Request review

A local application for reviewing a small set of requests. The queue lists pending requests and announces their count
in a status region. Approved and canceled requests remain readable but have no mutation actions.

Pending requests can be approved, canceled, or deleted. Cancellation and deletion each require their own confirmation
view and a way back without changing the request. Only cancellation asks for an optional reason and retains it with the
canceled request. Reasons are short notes; this application has no document editor. GET requests do not mutate data.

Run \`node --test\` for domain checks and \`node preview.mjs\` to use the interface. The preview binds to loopback and prints
its URL; Ctrl-C stops it. Its HTTP application factory is the public \`createApp()\` export from \`app.mjs\`.
\`/\` is the queue; \`/requests/ID\` reads a request; \`?mode=cancel\` and \`?mode=delete\` select confirmation views.
POST \`/requests/ID/action\` accepts \`action\` and optional \`reason\`, redirects to the queue, and rejects unavailable actions.
`,
    "package.json": JSON.stringify(interfacePackage, null, 2) + "\n",
    "model.mjs": model,
    "model.test.mjs": modelTests,
    "views.mjs": views(broken),
    "app.mjs": `import {requests, applyAction} from "./model.mjs";
import {renderQueue, renderRequest} from "./views.mjs";
export function createApp() {
  let items = structuredClone(requests);
  return async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const match = /^\\/requests\\/([a-z]+)(\\/action)?$/.exec(url.pathname);
    if (request.method === "GET" && url.pathname === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8"); response.end(renderQueue(items)); return;
    }
    const item = match && items.find((item) => item.id === match[1]);
    if (!item) { response.writeHead(404); response.end("Request not found"); return; }
    if (request.method === "GET" && !match[2]) {
      response.setHeader("content-type", "text/html; charset=utf-8"); response.end(renderRequest(item, url.searchParams.get("mode") ?? "read")); return;
    }
    if (request.method === "POST" && match[2]) {
      let body = ""; for await (const chunk of request) body += chunk;
      const fields = new URLSearchParams(body);
      try { items = applyAction(items, item.id, fields.get("action"), fields.get("reason") ?? ""); }
      catch { response.writeHead(409); response.end("Action unavailable"); return; }
      response.writeHead(303, {location:"/"}); response.end(); return;
    }
    response.writeHead(405); response.end("Method unavailable");
  };
}
`,
    "preview.mjs": `import {createServer} from "node:http";
import {createApp} from "./app.mjs";
const server = createServer(createApp());
server.listen(0, "127.0.0.1", () => console.log("http://127.0.0.1:" + server.address().port));
`,
  };
}

/** Run inside the disposable project; the HTTP application and probe share one owned process. */
export const interfaceProbe = `import {createServer} from "node:http";
import {once} from "node:events";
import {parseHTML} from ${JSON.stringify(import.meta.resolve("linkedom"))};
import {createApp} from "./app.mjs";
async function withApp(run) {
 const server = createServer(createApp());
 server.listen(0, "127.0.0.1"); await once(server, "listening");
 const base = "http://127.0.0.1:" + server.address().port;
 const read = async (path, fields) => {
   const url = new URL(path, base);
   if(url.origin !== base) return {status:0,body:"Control leaves the application"};
   const response = await fetch(url, fields ? {method:"POST",body:fields,redirect:"manual"} : {});
   return {status:response.status,body:await response.text(),location:response.headers.get("location")};
 };
 const redirect = (page) => typeof page.location === "string" && page.location ? read(page.location) : {status:0,body:"Action has no continuation"};
 const dom = (page) => parseHTML(page.body).document;
 const follow = (page, mode) => {
   const link = [...dom(page).querySelectorAll("a[href]")].find((link) => new URL(link.getAttribute("href"),base).searchParams.get("mode") === mode);
   return link ? read(link.getAttribute("href")) : {status:0,body:"Confirmation control unavailable"};
 };
 const submit = (page, action, reason) => {
   const form = [...dom(page).querySelectorAll("form")].find((form) => [...form.querySelectorAll('[name="action"]')].some((control) => control.getAttribute("value") === action && !control.hasAttribute("disabled")));
   if(!form || form.getAttribute("method")?.toLowerCase() !== "post") return {status:0,body:"Action form unavailable"};
   const fields = new URLSearchParams();
   for(const control of form.querySelectorAll("input[name],textarea[name]")) {
     if(control.hasAttribute("disabled")) continue;
     fields.set(control.getAttribute("name"),control.getAttribute("value") ?? control.textContent ?? "");
   }
   fields.set("action",action); if(reason !== undefined) fields.set("reason",reason);
   return read(form.getAttribute("action"),fields);
 };
 try {return await run({read,follow,submit,redirect});}
 finally {server.closeAllConnections();await new Promise((resolve) => server.close(resolve));}
}
const result = await withApp(async ({read,follow,submit,redirect}) => {
 const result = {queue:await read("/"),pending:await read("/requests/alpha"),approved:await read("/requests/gamma")};
 const beta = await read("/requests/beta");
 result.cancel = await follow(result.pending,"cancel"); result.delete = await follow(beta,"delete");
 result.unchanged = await read("/requests/beta");
 result.cancelAction = await submit(result.cancel,"cancel","No longer needed & confirmed");
 result.afterCancel = await redirect(result.cancelAction); result.canceled = await read("/requests/alpha");
 result.denied = await read("/requests/gamma/action",new URLSearchParams({action:"cancel"}));
 result.deleteAction = await submit(result.delete,"delete");
 result.empty = await redirect(result.deleteAction); result.deleted = await read("/requests/beta");
 return result;
});
Object.assign(result,await withApp(async ({read,submit,redirect}) => {
 const pending = await read("/requests/alpha");
 const approveAction = await submit(pending,"approve");
 return {approveAction,approveDestination:await redirect(approveAction),afterApprove:await read("/requests/alpha")};
}));
Object.assign(result,await withApp(async ({read,follow,submit,redirect}) => {
 const pending = await read("/requests/alpha"),cancel = await follow(pending,"cancel");
 const emptyReasonAction = await submit(cancel,"cancel","");
 return {emptyReasonAction,emptyReasonDestination:await redirect(emptyReasonAction),afterEmptyReason:await read("/requests/alpha")};
}));
console.log(JSON.stringify(result));
`;

export function verifyInterfaceProbe(contents: string): void {
  const pages = record(JSON.parse(contents), "Invalid interface evaluation response");
  const response = (name: string) => record(pages[name], `Missing interface response: ${name}`);
  const document = (name: string) => {
    assert.equal(response(name).status, 200, `Interface view unavailable: ${name}`);
    return parseHTML(string(response(name).body, "Missing interface document")).document;
  };
  const actions = (name: string) =>
    [...document(name).querySelectorAll("form")].flatMap((form) =>
      form.getAttribute("method")?.toLowerCase() !== "post"
        ? []
        : [...form.querySelectorAll('[name="action"]')]
            .filter((field) => field.getAttribute("type") !== "button" && !field.hasAttribute("disabled"))
            .map((field) => field.getAttribute("value")),
    );
  const pendingCount = (name: string, count: number) => {
    assert.match(
      document(name).querySelector('[role="status"]')?.textContent ?? "",
      new RegExp(`\\b${String(count)}\\b`),
      "Queue count disagrees with pending requests",
    );
  };
  pendingCount("queue", 2);
  const ids = [...document("queue").querySelectorAll("a[href]")].map(
    (link) => new URL(link.getAttribute("href") ?? "", "http://localhost").pathname,
  );
  assert(
    ids.includes("/requests/alpha") && ids.includes("/requests/beta") && !ids.includes("/requests/gamma"),
    "Queue mixes pending and approved requests",
  );
  const confirmationLinks = (name: string) =>
    [...document(name).querySelectorAll("a[href]")]
      .map((link) => new URL(link.getAttribute("href") ?? "", "http://localhost").searchParams.get("mode"))
      .filter((mode) => mode === "cancel" || mode === "delete");
  assert.deepEqual(confirmationLinks("approved"), [], "Approved request offers destructive navigation");
  assert.deepEqual(confirmationLinks("canceled"), [], "Canceled request offers destructive navigation");
  assert.deepEqual(
    confirmationLinks("pending").sort(),
    ["cancel", "delete"],
    "Confirmation controls are not discoverable",
  );
  assert.deepEqual(actions("approved"), [], "Approved request offers mutation actions");
  assert.deepEqual(actions("canceled"), [], "Canceled request offers mutation actions");
  assert.equal(response("approveAction").status, 303, "Approval control does not submit successfully");
  assert.deepEqual(actions("afterApprove"), [], "Approval leaves mutation controls available");
  assert.equal(response("emptyReasonAction").status, 303, "Cancellation requires a reason");
  assert.deepEqual(actions("afterEmptyReason"), [], "Cancellation leaves mutation controls available");
  assert.deepEqual(actions("pending"), ["approve"], "Ordinary reading mixes approval with destructive confirmation");
  for (const mode of ["cancel", "delete"] as const) {
    assert.deepEqual(actions(mode), [mode], "Confirmation mixes unrelated actions");
    const back = [...document(mode).querySelectorAll("a[href]")].some((link) =>
      /^\/requests\/(alpha|beta)$/.test(new URL(link.getAttribute("href") ?? "", "http://localhost").pathname),
    );
    assert(back, "Confirmation has no return to the request");
  }
  const reason = document("cancel").querySelector('[name="reason"]');
  assert(reason && !reason.hasAttribute("required"), "Cancellation reason is missing or mandatory");
  assert.equal(document("delete").querySelector('[name="reason"]'), null, "Deletion requests an unsaved reason");
  assert.equal(response("unchanged").status, 200, "Opening deletion changed the request");
  assert.equal(response("cancelAction").status, 303);
  assert.equal(response("deleteAction").status, 303);
  assert.equal(response("denied").status, 409);
  assert.equal(response("deleted").status, 404);
  assert.match(document("canceled").querySelector("main")?.textContent ?? "", /No longer needed & confirmed/);
  pendingCount("approveDestination", 1);
  pendingCount("emptyReasonDestination", 1);
  pendingCount("afterCancel", 1);
  pendingCount("empty", 0);
}
