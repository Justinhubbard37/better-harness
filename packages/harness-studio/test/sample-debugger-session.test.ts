import { describe, expect, it } from "vitest";
import { SAMPLE_DEBUGGER_SESSION } from "../src/app/run/sample-debugger-session.js";

describe("sample debugger session", () => {
  it("projects the requested sample as semantic stages with one grouped exploration", () => {
    expect(SAMPLE_DEBUGGER_SESSION.name).toBe("优化 Replay UI");
    expect(SAMPLE_DEBUGGER_SESSION.events.map((event) => event.kind)).toEqual([
      "prompt",
      "plan",
      "explore",
      "change",
      "verify",
      "change",
      "verify",
      "response",
    ]);
    expect(SAMPLE_DEBUGGER_SESSION.events.find((event) => event.id === "explore")?.toolCalls).toHaveLength(9);
    expect(SAMPLE_DEBUGGER_SESSION.events.filter((event) => event.diff !== undefined)).toHaveLength(2);
    expect(SAMPLE_DEBUGGER_SESSION.events.filter((event) => event.validation?.status === "failed")).toHaveLength(1);
    expect(SAMPLE_DEBUGGER_SESSION.events.filter((event) => event.validation?.status === "passed")).toHaveLength(1);
  });
});
