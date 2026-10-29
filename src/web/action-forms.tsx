import type { ComponentChildren, JSX } from "preact";
import { hidden, textField, textArea, selectField, confirmation } from "./components.js";
import { projectPath } from "./project-paths.js";
import { Route, type MutationFields } from "./routes.js";
import type { ViewContext } from "./view-context.js";

const protectedForms = {
  [Route.PolicyResolution]: "resolution",
  [Route.Save]: "editor",
  [Route.CreateCharter]: "editor",
  [Route.Approve]: "review",
  [Route.Apply]: "proposal",
} as const;
type ScopedAction =
  | keyof typeof protectedForms
  | typeof Route.Preview
  | typeof Route.WorkspaceRetry
  | typeof Route.TaskState
  | typeof Route.QueueChange;
interface EditableFields {
  [Route.TaskState]: { reviewed: "confirmation" };
  [Route.QueueChange]: { detail: "text"; mode: "select" };
  [Route.Save]: { contents: "area" };
  [Route.CreateCharter]: { contents: "area"; human_written: "confirmation" };
  [Route.Preview]: { id: "select"; source: "text"; commit: "text"; collection: "text"; visibility: "select" };
  [Route.ProjectAdd]: { path: "text" };
  [Route.CleanupApply]: { reviewed: "confirmation" };
}
type FieldName<R, K extends string> = R extends keyof EditableFields
  ? { [N in keyof EditableFields[R]]: EditableFields[R][N] extends K ? N : never }[keyof EditableFields[R]] & string
  : never;
type TextOptions = Omit<Parameters<typeof textField>[0], "name">;
type AreaOptions = Omit<Parameters<typeof textArea>[0], "name">;
type SelectOptions = Omit<Parameters<typeof selectField>[0], "name">;
interface Controls<R> {
  text: (name: FieldName<R, "text">, options: TextOptions) => JSX.Element;
  area: (name: FieldName<R, "area">, options: AreaOptions) => JSX.Element;
  select: (name: FieldName<R, "select">, options: SelectOptions) => JSX.Element;
  confirmation: (name: FieldName<R, "confirmation">, label: string) => JSX.Element;
}
const controls = {
  text: (name: string, options: TextOptions) => textField({ ...options, name }),
  area: (name: string, options: AreaOptions) => textArea({ ...options, name }),
  select: (name: string, options: SelectOptions) => selectField({ ...options, name }),
  confirmation,
};
type MutationForm<R extends keyof MutationFields> = {
  action: R;
  fields: MutationFields[NoInfer<R>];
  csrf: string;
  class?: string;
  children: (controls: Controls<NoInfer<R>>) => ComponentChildren;
} & (R extends ScopedAction ? { context: Pick<ViewContext, "selection" | "scope" | "all"> } : { context?: never });

/** Each mutation requires its version/target fields; request validation remains authoritative. */
export function mutationForm<R extends keyof MutationFields>(options: MutationForm<R>): JSX.Element {
  const context = options.context;
  const kind = Object.hasOwn(protectedForms, options.action)
    ? protectedForms[options.action as keyof typeof protectedForms]
    : undefined;
  return (
    <form
      method="post"
      action={context ? projectPath(options.action) : options.action}
      class={options.class}
      data-action={context ? "" : undefined}
      data-workspace-retry={options.action === Route.WorkspaceRetry ? "" : undefined}
      data-editor={kind === "editor" ? "" : undefined}
      data-review={kind === "review" ? "" : undefined}
      data-proposal={kind === "proposal" ? "" : undefined}
      data-resolution={kind === "resolution" ? "" : undefined}
    >
      {hidden("csrf", options.csrf)}
      {context && (
        <>
          {hidden("record_source", context.selection)}
          {hidden("record_scope", context.scope)}
          {hidden("record_all", context.all ? "1" : "0")}
        </>
      )}
      {Object.entries(options.fields).map(([name, value]) => hidden(name, value))}
      {options.children(controls)}
    </form>
  );
}
