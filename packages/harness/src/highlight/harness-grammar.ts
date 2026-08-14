import type { LanguageRegistration } from "shiki";

/**
 * TextMate grammar for the Harness DSL, registered with Shiki as the
 * `harness` language.
 */
export const harnessTextMateGrammar: LanguageRegistration = {
  name: "harness",
  scopeName: "source.harness",
  displayName: "Harness",
  patterns: [
    { include: "#comments" },
    { include: "#declarations" },
    { include: "#sections" },
    { include: "#constants" },
    { include: "#versions" },
    { include: "#durations" },
    { include: "#numbers" },
    { include: "#strings" },
  ],
  repository: {
    comments: {
      patterns: [
        { name: "comment.line.double-slash.harness", match: "//[^\\n]*" },
        { name: "comment.block.harness", begin: "/\\*", end: "\\*/" },
      ],
    },
    declarations: {
      patterns: [
        {
          match: "\\b(component|binding|plugin|composition)\\b\\s+([_a-zA-Z][\\w-]*)",
          captures: {
            "1": { name: "keyword.declaration.harness" },
            "2": { name: "entity.name.type.harness" },
          },
        },
        { name: "keyword.control.harness", match: "\\b(for|require|include|provides)\\b" },
      ],
    },
    sections: {
      patterns: [
        {
          name: "keyword.other.section.harness",
          match:
            "\\b(kind|description|input|output|permissions|mechanism|strength|notes|version|target|preferred|minimum|on-degrade|configure)\\b",
        },
      ],
    },
    constants: {
      patterns: [
        {
          name: "constant.language.strength.harness",
          match: "\\b(unsupported|advisory|wired|enforced)\\b",
        },
        {
          name: "constant.language.kind.harness",
          match: "\\b(skill|tool|program|workflow|hook|policy|observer|ui)\\b",
        },
        {
          name: "constant.language.permission.harness",
          match: "\\b(workspace|process|network|model|read|write|allow|deny)\\b",
        },
        { name: "constant.language.degrade.harness", match: "\\b(fail|report)\\b" },
        { name: "constant.language.boolean.harness", match: "\\b(true|false)\\b" },
      ],
    },
    versions: {
      patterns: [
        { name: "constant.other.version.harness", match: "@[~^]?[0-9][0-9a-zA-Z.+*-]*" },
      ],
    },
    durations: {
      patterns: [{ name: "constant.numeric.duration.harness", match: "\\b[0-9]+(ms|s|m|h)\\b" }],
    },
    numbers: {
      patterns: [{ name: "constant.numeric.integer.harness", match: "\\b[0-9]+\\b" }],
    },
    strings: {
      patterns: [{ name: "string.quoted.double.harness", match: '"[^"]*"' }],
    },
  },
};
