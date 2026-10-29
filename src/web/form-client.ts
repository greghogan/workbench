import { Notice, type BrowserSession } from "./browser-session.js";

/** Own form interaction and unsaved changes; mutations drain independently of navigation cleanup. */
export function startFormActions(session: BrowserSession): () => void {
  const { browser, document } = session;
  const input = (event: Event) => {
    if (!(event.target instanceof browser.Element)) return;
    if (event.target.closest("main form")) session.formDraft = true;
    if (event.target.closest("form[data-action]")) session.dirty = true;
  };
  const submit = async (event: SubmitEvent) => {
    const form = event.target;
    if (!(form instanceof browser.HTMLFormElement) || !form.hasAttribute("data-action")) return;
    event.preventDefault();
    const buttons = [...form.querySelectorAll<HTMLButtonElement>("button[type=submit]")];
    if (buttons.some((button) => button.disabled)) return;
    const retry = form.hasAttribute("data-workspace-retry"),
      wasDirty = session.dirty;
    session.dirty = true;
    for (const button of buttons) button.disabled = true;
    try {
      const body = new URLSearchParams();
      for (const [key, value] of new browser.FormData(form)) if (typeof value === "string") body.append(key, value);
      const response = await browser.fetch(form.action, {
        method: "POST",
        body,
        headers: { Accept: "application/json" },
      });
      const result: unknown = await response.json();
      if (session.isStopped()) return;
      if (!result || typeof result !== "object") throw new Error("Invalid service response");
      if (!response.ok) throw new Error("error" in result ? String(result.error) : "Request failed");
      if (
        !("redirect" in result) ||
        typeof result.redirect !== "string" ||
        !result.redirect.startsWith("/") ||
        result.redirect.startsWith("//")
      )
        throw new Error("Invalid service redirect");
      if (retry) {
        session.dirty = wasDirty;
        session.clearNotice(Notice.Workspace);
        for (const button of buttons) button.disabled = false;
        return;
      }
      session.dirty = false;
      browser.location.assign(result.redirect);
    } catch (error) {
      if (session.isStopped()) return;
      if (retry) session.dirty = wasDirty;
      session.notify(String(error));
      document.getElementById("live-status")?.focus();
      for (const button of buttons) button.disabled = session.staleReview && button.hasAttribute("data-approve");
    }
  };
  const submitted = (event: SubmitEvent) => {
    void submit(event);
  };
  const unload = (event: BeforeUnloadEvent) => {
    if (session.dirty) event.preventDefault();
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
