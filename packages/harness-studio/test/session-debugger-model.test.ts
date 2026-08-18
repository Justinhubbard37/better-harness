import { describe, expect, it } from "vitest";
import {
  cumulativeFileChanges,
  cursorForNode,
  DEFAULT_DEBUGGER_CURSOR,
  DEFAULT_STOP_CONDITIONS,
  eventForCursor,
  nextStopCursor,
  previousStateCursor,
  SAMPLE_DEBUGGER_SESSION,
  stepIntoCursor,
  stepOutCursor,
  stepOverCursor,
} from "../src/app/session-debugger-model.js";

describe("session debugger model", () => {
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

  it("continues only to events enabled by stop conditions", () => {
    expect(nextStopCursor(
      SAMPLE_DEBUGGER_SESSION,
      DEFAULT_DEBUGGER_CURSOR,
      DEFAULT_STOP_CONDITIONS,
    )).toEqual({ eventId: "test-failed" });

    expect(nextStopCursor(
      SAMPLE_DEBUGGER_SESSION,
      DEFAULT_DEBUGGER_CURSOR,
      { ...DEFAULT_STOP_CONDITIONS, failures: false, tests: false },
    )).toEqual({ eventId: "change-css" });

    expect(nextStopCursor(
      SAMPLE_DEBUGGER_SESSION,
      { eventId: "test-passed" },
      { changes: false, failures: false, permissions: false, tests: false, responses: true },
    )).toEqual({ eventId: "response" });
  });

  it("steps into, over, and out of a grouped tool-call sequence", () => {
    const into = stepIntoCursor(SAMPLE_DEBUGGER_SESSION, { eventId: "explore" });
    expect(into).toEqual({ eventId: "explore", toolCallId: "tool_read_workbench" });

    const over = stepOverCursor(SAMPLE_DEBUGGER_SESSION, into);
    expect(over).toEqual({ eventId: "explore", toolCallId: "tool_read_studio_css" });
    expect(stepOutCursor(over)).toEqual({ eventId: "explore" });
    expect(previousStateCursor(SAMPLE_DEBUGGER_SESSION, over)).toEqual(into);
  });

  it("resolves tree nodes and cumulative state without changing the workspace", () => {
    const toolCursor = cursorForNode(SAMPLE_DEBUGGER_SESSION, "tool_search_session");
    expect(toolCursor).toEqual({ eventId: "explore", toolCallId: "tool_search_session" });
    expect(eventForCursor(SAMPLE_DEBUGGER_SESSION, toolCursor!)).toMatchObject({ id: "explore", phase: "Explore" });

    expect(cumulativeFileChanges(SAMPLE_DEBUGGER_SESSION, { eventId: "test-passed" })).toEqual([
      expect.objectContaining({ path: "scripts/harness-inspector/ui/workbench.js", additions: 48, deletions: 21 }),
      expect.objectContaining({ path: "packages/harness-studio/src/app/index.html", additions: 14, deletions: 3 }),
    ]);
  });
});
