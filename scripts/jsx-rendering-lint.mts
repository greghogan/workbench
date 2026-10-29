import { defineConfig } from "eslint/config";
import jsxA11y from "eslint-plugin-jsx-a11y-x";
/** AST-only presentation rules, shared by enforcement and fast regression fixtures. */
export const jsxRenderingRules = defineConfig(
  {
    files: ["src/web/**/*.tsx"],
    extends: [jsxA11y.configs.strict],
    settings: { "jsx-a11y-x": { attributes: { for: ["for", "htmlFor"] } } },
    rules: {
      "jsx-a11y-x/anchor-ambiguous-text": "error",
      "jsx-a11y-x/control-has-associated-label": [
        "error",
        {
          // These controls use sibling/wrapping labels checked by label-has-associated-control and DOM tests.
          ignoreElements: ["input", "select", "textarea"],
        },
      ],
      "jsx-a11y-x/lang": "error",
      "jsx-a11y-x/no-aria-hidden-on-focusable": "error",
      "jsx-a11y-x/prefer-tag-over-role": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,mjs,cts,cjs}"],
    ignores: ["src/web/markdown-view.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXAttribute[name.name='dangerouslySetInnerHTML'], Property[key.name='dangerouslySetInnerHTML'], Property[key.value='dangerouslySetInnerHTML']",
          message: "Only markdown-view.tsx may insert raw HTML; compose all other content as JSX children.",
        },
      ],
    },
  },
);
