import { mutationForm } from "../../src/web/action-forms.js";
import { routeURL } from "../../src/web/locations.js";
import { Route } from "../../src/web/routes.js";
import { DifferenceLayout } from "../../src/web/navigation-state.js";

/** Compile-only contract fixtures; ordinary typechecking verifies every expected rejection. */
export function webFormContracts(): void {
  const context = { selection: "", scope: "fixture", all: false };
  const fields = {
    path: "workbench/decisions/ADR-00.md",
    digest: "exact",
    review_layout: DifferenceLayout.Inline,
    reviewed: "yes" as const,
    human_written: "no" as const,
  };
  const review = { action: Route.Approve, fields, csrf: "session", context, children: () => null };
  mutationForm(review);
  const missingDigest = {
    ...review,
    fields: { path: fields.path, review_layout: fields.review_layout },
  };
  // @ts-expect-error Reviews require the exact displayed version.
  mutationForm(missingDigest);
  const missingVersion = {
    action: Route.Save,
    fields: { id: "fixture:ADR-0" },
    csrf: "session",
    context,
    children: () => null,
  };
  // @ts-expect-error Saving requires the expected document version.
  mutationForm(missingVersion);
  mutationForm({
    action: Route.Save,
    fields: { id: "fixture:ADR-0", expected: "exact" },
    csrf: "session",
    context,
    children: (controls) => {
      const options = { id: "editor", label: "Source", value: "text" };
      controls.area("contents", options);
      // @ts-expect-error Submitted editor names belong to the selected action.
      controls.area("content", options);
      // @ts-expect-error Contents is a textarea field, not a text input.
      controls.text("contents", options);
      return null;
    },
  });
  const wrongReviewView = { view: "edit" } as const;
  // @ts-expect-error Review pages do not offer record editing.
  routeURL(Route.Review, wrongReviewView);
  // @ts-expect-error Record review has no staging selector.
  routeURL(Route.Review, { path: fields.path, review_source: "staged" });
  // @ts-expect-error A record link requires an identity.
  routeURL(Route.Record, {});
}
