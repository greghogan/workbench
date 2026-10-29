import { ResponseProblem } from "./response-problem.js";
import { decodeRecovery } from "./recovery.js";
import { Notice, type BrowserSession } from "./browser-session.js";

/** Own form interaction and unsaved changes; mutations drain independently of navigation cleanup. */
export function startFormActions(session: BrowserSession): () => void {
  const { browser, document } = session;
  const input = (event: Event) => {
    if (!(event.target instanceof browser.Element)) return;
    const form = event.target.closest<HTMLFormElement>("main form");
    if (form) {
      form.dataset.unsavedForm = "";
      session.formDraft = true;
      session.dirty = true;
    }
  };
  const submit = async (event: SubmitEvent) => {
    const form = event.target;
    if (!(form instanceof browser.HTMLFormElement) || !form.hasAttribute("data-action")) return;
    event.preventDefault();
    if (session.pendingActions.has(form)) return;
    const buttons = [...form.querySelectorAll<HTMLButtonElement>("button")].filter(
      (button) => button.type === "submit",
    );
    if (buttons.some((button) => button.disabled)) return;
    const retry = form.hasAttribute("data-workspace-retry");
    const body = new URLSearchParams();
    for (const [key, value] of new browser.FormData(form)) if (typeof value === "string") body.append(key, value);
    const restore: (() => void)[] = [];
    session.pendingActions.add(form);
    form.setAttribute("aria-busy", "true");
    // The response acknowledges the submitted version. Keep it selectable without permitting edits that a redirect
    // would discard; unrelated forms remain usable, and failed submissions restore the original control state.
    for (const control of form.elements) {
      if (
        control instanceof browser.HTMLTextAreaElement ||
        (control instanceof browser.HTMLInputElement &&
          ["text", "search", "email", "url", "tel", "password", "number"].includes(control.type))
      ) {
        const before = control.readOnly;
        control.readOnly = true;
        restore.push(() => {
          control.readOnly = before;
        });
      } else if (
        control instanceof browser.HTMLButtonElement ||
        control instanceof browser.HTMLSelectElement ||
        (control instanceof browser.HTMLInputElement && control.type !== "hidden")
      ) {
        const before = control.disabled;
        control.disabled = true;
        restore.push(() => {
          control.disabled = before || (session.staleDraft && control.hasAttribute("data-approve"));
        });
      }
    }
    try {
      const response = await browser.fetch(form.action, {
        method: "POST",
        body,
        headers: { Accept: "application/json" },
      });
      const result: unknown = await response.json();
      if (session.isStopped()) return;
      if (!result || typeof result !== "object") throw new Error("Invalid service response");
      if (!response.ok)
        throw new ResponseProblem(
          "error" in result ? String(result.error) : "Request failed",
          "recovery" in result ? decodeRecovery(result.recovery) : undefined,
        );
      if (
        !("redirect" in result) ||
        typeof result.redirect !== "string" ||
        !result.redirect.startsWith("/") ||
        result.redirect.startsWith("//")
      )
        throw new Error("Invalid service redirect");
      if (retry) {
        session.clearNotice(Notice.Workspace);
        return;
      }
      delete form.dataset.unsavedForm;
      if (document.querySelector("main form[data-unsaved-form]")) {
        session.notify("Action completed. Other unsaved form entries are preserved on this page.");
        return;
      }
      session.dirty = false;
      session.pendingActions.delete(form);
      browser.location.assign(result.redirect);
    } catch (error) {
      if (session.isStopped()) return;
      session.notify(
        error instanceof Error ? error.message : String(error),
        Notice.Action,
        error instanceof ResponseProblem ? error.recovery : undefined,
      );
      document.getElementById("live-status")?.focus();
    } finally {
      session.pendingActions.delete(form);
      form.removeAttribute("aria-busy");
      for (const action of restore) action();
    }
  };
  const submitted = (event: SubmitEvent) => {
    void submit(event);
  };
  const unload = (event: BeforeUnloadEvent) => {
    if (session.dirty || session.pendingActions.size) event.preventDefault();
  };
  document.addEventListener("input", input);
  document.addEventListener("submit", submitted);
  browser.addEventListener("beforeunload", unload);
  return () => {
    document.removeEventListener("input", input);
    document.removeEventListener("submit", submitted);
    browser.removeEventListener("beforeunload", unload);
  };
}
