import { diffLines } from "diff";
import type { ViewContext } from "./view-context.js";
import type { ReviewFormatting } from "../review-formatting.js";
import { mutationForm } from "./action-forms.js";
import { submitButton } from "./components.js";
import { shell } from "./page-frame.js";
import { Route } from "./routes.js";

export function reviewFormattingPage(context: ViewContext, proposal: ReviewFormatting, path = ""): string {
  return shell(
    context,
    "Review formatting",
    "review",
    <section data-proposal="">
      <p>Review the proposed formatting before reviewing the record contents.</p>
      {proposal.remaining && <p>More files will be checked after applying this batch.</p>}
      {proposal.files.map((file) => (
        <section key={file.path}>
          <h2>{file.path}</h2>
          <pre class="source">
            {(
              diffLines(file.original, file.formatted, { maxEditLength: 2000 }) ?? [
                { removed: true, added: false, value: file.original },
                { removed: false, added: true, value: file.formatted },
              ]
            ).map((part) =>
              part.added ? <ins>{part.value}</ins> : part.removed ? <del>{part.value}</del> : part.value,
            )}
          </pre>
        </section>
      ))}
      {mutationForm({
        action: Route.FormatReview,
        context,
        csrf: context.csrf,
        fields: { expected: proposal.digest, path },
        children: () => submitButton("Apply formatting"),
      })}
    </section>,
  );
}
