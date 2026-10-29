import { BrowserSession, type Browser } from "./browser-session.js";
import { startFormActions } from "./form-client.js";
import { startHubUpdates } from "./hub-client.js";
import { startRecordLoading } from "./list-client.js";
import { startLiveUpdates } from "./live-client.js";
import { startReferencePreviews } from "./reference-client.js";
import { startSourceNavigation } from "./source-client.js";

/** Progressive enhancement controllers share read coordination while retaining distinct resource ownership. */
interface DraftState {
  dirty: boolean;
  formDraft: boolean;
  staleReview: boolean;
}
function startPage(browser: Browser, state: { draft?: DraftState }): () => void {
  if (browser.document.body.hasAttribute("data-project-hub")) return startHubUpdates(browser);
  const session = new BrowserSession(browser);
  if (state.draft) {
    Object.assign(session, state.draft);
    if (state.draft.staleReview) session.preserveDraft();
  }
  const records = startRecordLoading(session);
  const sources = startSourceNavigation(session);
  const closeLive = startLiveUpdates(session, () => {
    records.watch();
    sources.refresh();
  });
  const closeForms = startFormActions(session);
  const closeReferences = startReferencePreviews(session);
  return () => {
    state.draft = { dirty: session.dirty, formDraft: session.formDraft, staleReview: session.staleReview };
    session.close();
    closeLive();
    sources.close();
    records.close();
    closeForms();
    closeReferences();
  };
}
export function startBrowser(browser: Browser): () => void {
  const state: { draft?: DraftState } = {};
  let cleanup: (() => void) | undefined = startPage(browser, state);
  const hide = () => {
    cleanup?.();
    cleanup = undefined;
  };
  const show = () => {
    cleanup ??= startPage(browser, state);
  };
  browser.addEventListener("pagehide", hide);
  browser.addEventListener("pageshow", show);
  return () => {
    browser.removeEventListener("pagehide", hide);
    browser.removeEventListener("pageshow", show);
    hide();
  };
}
if (typeof window !== "undefined") startBrowser(window);
