import { describe, expect, it } from "vitest";
import { highlightStudioCode } from "../src/app/code-highlight.js";

describe("Studio syntax highlighting", () => {
  it("loads one grammar on demand without changing the source text", async () => {
    const source = '{\n  "ok": true\n}';
    const lines = await highlightStudioCode(source, "result.json");
    expect(lines).toBeDefined();
    expect(lines!.map((line) => line.map((token) => token.content).join("")).join("\n")).toBe(source);
    expect(lines!.flat().some((token) => token.color !== undefined)).toBe(true);
  });

  it("keeps unknown sources as plain text", async () => {
    await expect(highlightStudioCode("plain output", "terminal.txt")).resolves.toBeUndefined();
  });
});
