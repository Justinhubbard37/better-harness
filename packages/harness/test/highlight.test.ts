import { describe, expect, it } from "vitest";
import { highlightHarness, tokenizeHarness } from "../src/highlight/shiki.js";

const SAMPLE = `// assemble
composition standard-coding {
  target pi
  include [ plugin.change-verification@^2 ]
  require verification-before-complete {
    minimum wired
  }
  configure {
    shell.timeout = 60s
  }
}
`;

function findToken(tokens: Awaited<ReturnType<typeof tokenizeHarness>>, content: string) {
  for (const line of tokens) {
    for (const token of line) {
      if (token.content.trim() === content) {
        return token;
      }
    }
  }
  return undefined;
}

describe("harness syntax highlighting", () => {
  it("renders themed HTML for the registered harness language", async () => {
    const html = await highlightHarness(SAMPLE);

    expect(html.startsWith("<pre")).toBe(true);
    expect(html).toContain("standard-coding");
  });

  it("tokenizes keywords, constants, and comments with distinct colors", async () => {
    const tokens = await tokenizeHarness(SAMPLE);

    const keyword = findToken(tokens, "composition");
    const strength = findToken(tokens, "wired");
    const name = findToken(tokens, "standard-coding");
    const comment = findToken(tokens, "// assemble");

    expect(keyword).toBeDefined();
    expect(strength).toBeDefined();
    expect(name).toBeDefined();
    expect(comment).toBeDefined();
    // Behavioural contract of the grammar: these categories must not fall
    // back to one identical style.
    expect(keyword!.color).not.toBe(name!.color);
    expect(strength!.color).not.toBe(name!.color);
    expect(comment!.color).not.toBe(keyword!.color);
  });

  it("splits declaration keyword and declared name into separate tokens", async () => {
    const tokens = await tokenizeHarness("composition standard-coding {\n}\n");
    const firstLine = tokens[0].map((token) => token.content.trim()).filter(Boolean);

    expect(firstLine[0]).toBe("composition");
    expect(firstLine).toContain("standard-coding");
  });
});
