import { Linter } from "eslint";
import { expect, test } from "vitest";
import { explainedSecurityExceptions } from "../scripts/security-lint.mjs";
const lint = (text: string) =>
  new Linter().verify(text, [
    {
      plugins: { security: { rules: { explained: explainedSecurityExceptions } } },
      rules: { "security/explained": "error" },
    },
  ]);
test("security exceptions require specific rule identities and a meaningful explanation", () => {
  expect(lint("// codeql[js/file-system-race] Exclusive creation rejects existing files.\nvoid 0;")).toEqual([]);
  expect(
    lint(
      "// codeql[js/file-system-race] codeql[js/insecure-temporary-file] Private mode-0700 scratch, exclusively created.\nvoid 0;",
    ),
  ).toEqual([]);
  for (const comment of [
    "codeql[js/file-system-race]",
    "codeql[all] Ignore",
    "codeql[] More than twenty words of explanation",
    "codeql[js/file-system-race] Safe",
  ])
    expect(lint(`// ${comment}\nvoid 0;`)).toMatchObject([{ ruleId: "security/explained" }]);
});

test("legacy, file-wide and embedded suppressions cannot bypass canonical exception linting", () => {
  for (const text of [
    "// lgtm\nvoid 0;",
    "// lgtm[js/file-system-race]\nvoid 0;",
    "// codeql[js/file-system-race] Explained private ownership. lgtm\nvoid 0;",
    "/* codeql[js/file-system-race] Explained private ownership. */\nvoid 0;",
    "// codeql[js/*] Explained private ownership.\nvoid 0;",
    "// codeql[js/file-system-race] Explained private ownership. codeql[js/other]\nvoid 0;",
  ])
    expect(lint(text)).toMatchObject([{ ruleId: "security/explained" }]);
});
