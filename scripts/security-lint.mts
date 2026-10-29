import type { Rule } from "eslint";

/** CodeQL records in-source exceptions in SARIF; keep their scope and rationale reviewable here. */
export const explainedSecurityExceptions: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      explanation: "Use explicit CodeQL rule IDs and explain the trust or ownership invariant after the annotation.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (!comment.loc) throw new Error("Parser returned a comment without a source location");
          const text = comment.value.trim();
          if (!/\b(?:codeql\s*\[|lgtm\b)/i.test(text)) continue;
          // Parse every annotation before the rationale; a legacy or embedded suppression is never rationale.
          const parsed = /^(?:codeql\[js\/[a-z0-9-]+\]\s*)+(.+)$/u.exec(text);
          const reason = parsed?.[1]?.trim();
          if (comment.type !== "Line" || !reason || /\b(?:codeql\s*\[|lgtm\b)/i.test(reason) || reason.length < 20)
            context.report({ loc: comment.loc, messageId: "explanation" });
        }
      },
    };
  },
};
