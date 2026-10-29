import type { ComponentChildren, JSX } from "preact";
import { recordPresentations, recordTypes } from "../record-metadata.js";
import { projectPath } from "./project-paths.js";
import type { SearchType } from "./view-context.js";
/** Small server-rendered controls. Text and attribute values are escaped by the renderer. */
export const hidden = (name: string, value: string): JSX.Element => <input type="hidden" name={name} value={value} />;
export function workbenchBrand(): JSX.Element {
  return (
    <div class="brand">
      <svg class="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path d="M6 5H3v22h3M26 5h3v22h-3" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        <path
          d="m8 10 4 12 4-8 4 8 4-12"
          stroke="currentColor"
          stroke-width="2.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span>Workbench</span>
    </div>
  );
}
export const badge = (label: string, tone: "" | "approved" | "pending" = ""): JSX.Element => (
  <span class={"badge" + (tone ? " " + tone : "")}>{label}</span>
);

export function submitButton(label: string, options: { secondary?: boolean; approve?: boolean } = {}): JSX.Element {
  return (
    <button
      type="submit"
      class={options.secondary ? "secondary" : undefined}
      data-approve={options.approve ? "" : undefined}
    >
      {label}
    </button>
  );
}

interface TextField {
  id: string;
  name: string;
  label: string;
  value?: string;
  placeholder?: string;
  maxLength?: number;
  pattern?: string;
  required?: boolean;
  spellcheck?: boolean;
}
function field(label: string, id: string, control: JSX.Element): JSX.Element {
  return (
    <label for={id}>
      {label}
      {control}
    </label>
  );
}
export function textField(options: TextField): JSX.Element {
  return field(
    options.label,
    options.id,
    <input
      id={options.id}
      name={options.name}
      value={options.value}
      placeholder={options.placeholder}
      maxLength={options.maxLength}
      pattern={options.pattern}
      required={options.required}
      spellcheck={options.spellcheck}
    />,
  );
}
export function textArea(options: Pick<TextField, "id" | "name" | "label"> & { value: string }): JSX.Element {
  return field(
    options.label,
    options.id,
    <textarea id={options.id} name={options.name} spellcheck={false} required>
      {options.value}
    </textarea>,
  );
}
export interface Choice {
  value: string;
  label: string;
}
export function selectField(options: {
  id: string;
  name: string;
  label: string;
  value: string;
  choices: Choice[];
}): JSX.Element {
  return (
    <div class="field">
      <label for={options.id}>{options.label}</label>
      <select id={options.id} name={options.name} value={options.value}>
        {options.choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    </div>
  );
}
export function confirmation(name: string, label: string): JSX.Element {
  return (
    <label class="check-row">
      <input type="checkbox" name={name} value="yes" required />
      {label}
    </label>
  );
}

export function panel(
  contents: ComponentChildren,
  options: { heading?: string; tabs?: ComponentChildren; tools?: ComponentChildren } = {},
): JSX.Element {
  return (
    <section class="panel">
      {options.heading !== undefined && (
        <div class="panel-heading">
          <h2>{options.heading}</h2>
        </div>
      )}
      {options.tools ? (
        <div class="panel-controls">
          {options.tabs}
          {options.tools}
        </div>
      ) : (
        options.tabs
      )}
      <div class="panel-body">{contents}</div>
    </section>
  );
}

export function headerSearch(search?: { query: string; type: SearchType }): JSX.Element {
  const choices = [
    { value: "", label: "All types" },
    ...recordTypes.map((type) => ({ value: type, label: recordPresentations[type].label })),
  ];
  return (
    <form action={projectPath("/records")} role="search">
      <input type="hidden" name="all" value="1" />
      <label class="sr-only" for="global-search">
        Search all records
      </label>
      <input
        id="global-search"
        name="q"
        placeholder="Search all records…"
        maxLength={512}
        value={search?.query ?? ""}
      />
      <label class="sr-only" for="global-search-type">
        Record type
      </label>
      <select id="global-search-type" name="type" value={search?.type ?? ""}>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
      <button type="submit">Search</button>
    </form>
  );
}
