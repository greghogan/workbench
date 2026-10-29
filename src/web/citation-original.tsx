import { pageDocument } from "./page-document.js";
import { recordURL, routeURL } from "./locations.js";
import { Route } from "./routes.js";

/** Trusted controls live outside the opaque-origin source frame. Remote-image consent is explicit in its URL. */
export function citationOriginalPage(id: string, source: string, images: boolean): string {
  const values = { id, source, images: images ? ("1" as const) : ("0" as const) };
  return pageDocument({
    title: "Original citation",
    interactive: false,
    contents: (
      <main id="main" class="citation-viewer">
        <nav class="citation-viewer-toolbar" aria-label="Citation document">
          <a href={recordURL(id)}>Back to citation</a>
          <a href={routeURL(Route.CitationDocument, { id, source })}>Read</a>
          <span aria-current="page">Original</span>
          <a
            class="button secondary"
            href={routeURL(Route.CitationOriginal, { ...values, images: images ? "0" : "1" })}
          >
            {images ? "Block images" : "Enable images"}
          </a>
          <a class="button secondary" href={routeURL(Route.CitationOriginal, { ...values, download: "1" })}>
            Download original
          </a>
        </nav>
        <iframe
          class="citation-viewer-frame"
          title="Original source document"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerpolicy="no-referrer"
          src={routeURL(Route.CitationOriginalContent, values)}
        />
      </main>
    ),
  });
}
