import { startFileDifferences } from "./file-diff-client.js";
import { startCommitFiles } from "./commit-files-client.js";
import { startLocalTimes } from "./date-time-client.js";
import { startTaskTreeLoading } from "./task-tree-client.js";
import { BrowserSession, type Browser } from "./browser-session.js";
import { startFormActions } from "./form-client.js";
import { startHubUpdates } from "./hub-client.js";
import { startRecordLoading } from "./list-client.js";
import { captureLiveRegions, startLiveUpdates } from "./live-client.js";
import { startReferencePreviews } from "./reference-client.js";
import { startSourceNavigation } from "./source-client.js";
import { startCardNavigation } from "./card-client.js";
import { startDiagrams } from "./diagram-client.js";

/** Progressive enhancement controllers share read coordination while retaining distinct resource ownership. */
interface DraftState {
  dirty: boolean;
  formDraft: boolean;
  staleDraft: boolean;
}
function startPage(
  browser: Browser,
  state: { draft?: DraftState },
  regions: ReturnType<typeof captureLiveRegions>,
): () => void {
  const closeTimes = startLocalTimes(browser);
  if (browser.document.body.hasAttribute("data-project-hub")) {
    const closeHub = startHubUpdates(browser);
    return () => {
      closeHub();
      closeTimes();
    };
  }
  const session = new BrowserSession(browser);
  if (state.draft) {
    Object.assign(session, state.draft);
    if (state.draft.staleDraft) session.preserveDraft();
  }
  const records = startRecordLoading(session);
  const taskTree = startTaskTreeLoading(session);
  const commits = startCommitFiles(session);
  const differences = startFileDifferences(session);
  const sources = startSourceNavigation(session);
  const diagrams = startDiagrams(browser);
  const forms = startFormActions(session);
  const closeLive = startLiveUpdates(session, regions, () => {
    records.watch();
    taskTree.watch();
    commits.watch();
    differences.watch();
    sources.refresh();
    diagrams.watch();
    forms.watch();
  });
  const closeReferences = startReferencePreviews(session);
  const closeCards = startCardNavigation(session);
  return () => {
    state.draft = { dirty: session.dirty, formDraft: session.formDraft, staleDraft: session.staleDraft };
    session.close();
    closeTimes();
    closeLive();
    sources.close();
    records.close();
    taskTree.close();
    commits.close();
    differences.close();
    forms.close();
    closeReferences();
    closeCards();
    diagrams.close();
  };
}
export function startBrowser(browser: Browser): () => void {
  const state: { draft?: DraftState } = {},
    regions = captureLiveRegions(browser.document);
  let cleanup: (() => void) | undefined = startPage(browser, state, regions);
  const hide = () => {
    cleanup?.();
    cleanup = undefined;
  };
  const show = () => {
    cleanup ??= startPage(browser, state, regions);
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
