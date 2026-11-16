import type { ComponentChildren } from "preact";
import type { HistoryFile } from "../../core/git/history.js";
import { diffIcon } from "./diff-icons.js";

interface FileNode {
  name: string;
  path: string;
  children: Map<string, FileNode>;
}

export function commitFileId(path: string): string {
  return "commit-file-" + Buffer.from(path).toString("base64url");
}

export function commitNavigation(
  files: readonly HistoryFile[],
  selected: string | undefined,
  location: (path: string) => string,
  children: ComponentChildren,
) {
  const tree = new Map<string, FileNode>();
  for (const file of files) {
    let children = tree,
      path = "";
    for (const name of file.path.split("/")) {
      path += (path ? "/" : "") + name;
      let node = children.get(name);
      if (!node) {
        node = { name, path, children: new Map() };
        children.set(name, node);
      }
      children = node.children;
    }
  }
  const nodes = (children: Map<string, FileNode>): ComponentChildren => (
    <ul>
      {[...children.values()].map((node) =>
        node.children.size ? (
          <li data-commit-directory="">
            <details open>
              <summary>
                {diffIcon("chevron")}
                {diffIcon("folder")}
                <span>{node.name}</span>
              </summary>
              {nodes(node.children)}
            </details>
          </li>
        ) : (
          <li data-commit-file-path={node.path}>
            <a href={location(node.path)} title={node.path} aria-current={selected === node.path ? "page" : undefined}>
              {diffIcon("file")}
              <span>{node.name}</span>
            </a>
          </li>
        ),
      )}
    </ul>
  );
  return (
    <div class="commit-workspace" data-commit-inspection="">
      <nav class="commit-navigation" aria-label="Changed files">
        <h2 class="commit-navigation-heading">
          {diffIcon("files")}
          <span>Files ({String(files.length)})</span>
        </h2>
        <label hidden data-commit-filter="">
          Filter files
          <input type="search" data-commit-file-filter="" />
        </label>
        {/* The file tree scrolls independently and can be reached with the keyboard. */}
        {/* eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex */}
        <section class="commit-navigation-list" aria-label="File list" tabIndex={0}>
          {nodes(tree)}
        </section>
      </nav>
      <div class="commit-content">{children}</div>
    </div>
  );
}
