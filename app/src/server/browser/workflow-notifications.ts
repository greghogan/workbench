import type { BrowserSession } from "./browser-session.js";
import type { WorkflowDecision } from "../workspace/workflow-updates.js";

const notificationKey = "workbench:workflow-notifications";

function decision(value: unknown): value is WorkflowDecision {
  return (
    !!value &&
    typeof value === "object" &&
    "key" in value &&
    typeof value.key === "string" &&
    "title" in value &&
    typeof value.title === "string" &&
    "href" in value &&
    typeof value.href === "string" &&
    "kind" in value &&
    (value.kind === "plan" || value.kind === "outcome")
  );
}
function newDecisions(session: BrowserSession, revision: string, items: WorkflowDecision[]): WorkflowDecision[] {
  const { browser, document } = session;
  try {
    const stored: unknown = JSON.parse(browser.localStorage.getItem(notificationKey) ?? "[]");
    const known = new Set(Array.isArray(stored) ? stored.filter((value) => typeof value === "string") : []);
    const added = items.filter((item) => {
      const key = JSON.stringify([document.body.dataset.projectBase, revision, item.key]);
      if (known.has(key)) return false;
      known.add(key);
      return true;
    });
    browser.localStorage.setItem(notificationKey, JSON.stringify([...known].slice(-100)));
    return added;
  } catch {
    return items;
  }
}

export function startWorkflowNotifications(session: BrowserSession, events: EventSource): () => void {
  const { browser, document } = session;
  const notification = (): typeof Notification | undefined => {
    const candidate: unknown = Reflect.get(browser, "Notification");
    return typeof candidate === "function" ? (candidate as typeof Notification) : undefined;
  };
  let requested = false;
  const requestPermission = (event: Event) => {
    const Notify = notification();
    const activation = Reflect.get(browser.navigator, "userActivation") as UserActivation | undefined;
    if (
      requested ||
      !browser.isSecureContext ||
      Notify?.permission !== "default" ||
      !(activation?.isActive ?? event.isTrusted)
    )
      return;
    requested = true;
    void Notify.requestPermission().catch(() => undefined);
  };
  const attention = (event: MessageEvent<string>) => {
    let value: unknown;
    try {
      value = JSON.parse(event.data);
    } catch {
      return;
    }
    if (
      !value ||
      typeof value !== "object" ||
      !("revision" in value) ||
      typeof value.revision !== "string" ||
      !("count" in value) ||
      typeof value.count !== "number" ||
      !Number.isSafeInteger(value.count) ||
      !("items" in value) ||
      !Array.isArray(value.items) ||
      !value.items.every(decision)
    )
      return;
    const { count, items, revision } = value;
    if (!items.length || count < items.length || session.isStopped()) return;
    const message = (selected: number) =>
      selected === 1
        ? items[0]?.kind === "plan"
          ? "A plan needs approval"
          : "A task is ready for review"
        : `${String(selected)} items need your attention`;
    const status = document.getElementById("workflow-notice");
    if (status) status.textContent = message(count);
    const deliver = () => {
      const Notify = notification();
      if (session.isStopped() || document.hasFocus() || !browser.isSecureContext || Notify?.permission !== "granted")
        return;
      const unread = newDecisions(session, revision, items);
      const first = unread[0];
      if (!first) return;
      const url = new URL(first.href, browser.location.href);
      if (url.origin !== browser.location.origin) return;
      const total = unread.length + count - items.length;
      const alert = new Notify(
        total === 1 ? (first.kind === "plan" ? "Plan needs approval" : "Task ready for review") : message(total),
        {
          body: total === 1 ? first.title : "",
          tag: JSON.stringify([document.body.dataset.projectBase, revision, first.key]),
        },
      );
      alert.onclick = () => {
        browser.open(url.href, "_blank", "noopener");
        alert.close();
      };
    };
    const locks = Reflect.get(browser.navigator, "locks") as LockManager | undefined;
    if (locks) void locks.request(notificationKey, deliver).catch(() => undefined);
    else
      try {
        deliver();
      } catch {
        // The in-page announcement remains available when desktop delivery fails.
      }
  };
  document.addEventListener("click", requestPermission, true);
  document.addEventListener("keydown", requestPermission, true);
  events.addEventListener("attention", attention);
  return () => {
    document.removeEventListener("click", requestPermission, true);
    document.removeEventListener("keydown", requestPermission, true);
    events.removeEventListener("attention", attention);
  };
}
