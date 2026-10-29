import type { ComponentChildren } from "preact";
import { renderToString } from "preact-render-to-string";

interface PageDocument {
  title: string;
  contents: ComponentChildren;
  attributes?: Record<`data-${string}`, string>;
}
export function pageDocument({ title, contents, attributes = {} }: PageDocument): string {
  return (
    "<!doctype html>" +
    renderToString(
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <title>{title} · Workbench</title>
          <link rel="stylesheet" href="/assets/style.css" />
          <script src="/assets/client.js" defer />
        </head>
        <body {...attributes}>
          <a class="skip" href="#main">
            Skip to content
          </a>
          {contents}
        </body>
      </html>,
    )
  );
}
