import { describe, expect, it } from "vitest";
import {
  filteredCallCount,
  groupToolRuns,
  observedDurationTotal,
  projectSessionTrace,
  replayIndexForFile,
  sessionTurns,
  type InspectorSession,
} from "../src/app/inspector-session-model.js";

function session(): InspectorSession {
  return {
    sessionId: "session-1",
    platform: "qoder",
    firstSeen: "2026-08-24T09:00:00.000Z",
    lastSeen: "2026-08-24T10:00:00.000Z",
    prompts: [{ text: "Repair the renderer", turnIndex: 1 }],
    dialogue: {
      turns: [{
        index: 1,
        anchorId: "turn-1",
        startMs: Date.parse("2026-08-24T09:10:00.000Z"),
        endMs: Date.parse("2026-08-24T09:40:00.000Z"),
        prompt: { text: "Repair the renderer" },
        steps: [
          { kind: "tool", id: "step-1", callId: "call-2", toolName: "Edit" },
          { kind: "note", id: "note-1", text: "Checking the result" },
          { kind: "tool", id: "step-2", callId: "call-1", toolName: "Read" },
        ],
      }],
    },
    toolActivity: {
      files: [{ path: "src/orphan.ts" }],
      calls: [
        { id: "call-1", toolName: "Read", actionLabel: "Read file", family: "inspect", startedAt: 20 },
        { id: "call-2", toolName: "Edit", actionLabel: "Edit file", family: "change", startedAt: 10 },
        { id: "call-3", toolName: "Bash", actionLabel: "Run command", family: "verify", startedAt: 30 },
      ],
    },
  };
}

describe("Inspector retained Session projection", () => {
  it("resolves ordered Turn steps through the retained call ledger and keeps unplaced calls separate", () => {
    const projected = projectSessionTrace(session(), []);
    expect(projected.turns[0]?.calls.map((call) => call.id)).toEqual(["call-2", "call-1"]);
    expect(projected.unplacedCalls.map((call) => call.id)).toEqual(["call-3"]);
    expect(projected.unplacedFiles).toEqual(["src/orphan.ts"]);
  });

  it("places commits only inside observed Turn windows and labels outside timing", () => {
    const projected = projectSessionTrace(session(), [
      { hash: "inside", committedAt: "2026-08-24T09:20:00.000Z" },
      { hash: "before", committedAt: "2026-08-24T08:50:00.000Z" },
      { hash: "after", committedAt: "2026-08-24T10:10:00.000Z" },
    ]);
    expect(projected.turns[0]?.commits.map((commit) => commit.hash)).toEqual(["inside"]);
    expect(projected.outsideCommits).toEqual([
      expect.objectContaining({ relation: "before this Session started" }),
      expect.objectContaining({ relation: "after this Session ended" }),
    ]);
  });

  it("uses retained prompts as conservative fallback Turns", () => {
    const fallback = { ...session(), dialogue: undefined };
    expect(sessionTurns(fallback)).toMatchObject([{ index: 1, responseStatus: "unavailable", toolCallCount: 0 }]);
  });

  it("groups only adjacent indistinguishable calls and counts active tool filters", () => {
    const calls = [
      { id: "1", toolName: "Read", actionLabel: "Read file" },
      { id: "2", toolName: "Read", actionLabel: "Read file" },
      { id: "3", toolName: "Edit", actionLabel: "Edit file" },
      { id: "4", toolName: "Read", actionLabel: "Read file" },
    ];
    expect(groupToolRuns(calls).map((run) => run.calls.map((call) => call.id))).toEqual([["1", "2"], ["3"], ["4"]]);
    expect(filteredCallCount(calls, new Set(["Read"]))).toBe(3);
  });

  it("does not invent a zero duration when a grouped run has no observed timing", () => {
    expect(observedDurationTotal([
      { id: "1", durationStatus: "unobserved" },
      { id: "2", durationStatus: "unobserved", durationMs: 0 },
    ])).toBeUndefined();
    expect(observedDurationTotal([
      { id: "1", durationStatus: "observed", durationMs: 125 },
      { id: "2", durationStatus: "unobserved" },
      { id: "3", durationStatus: "observed", durationMs: 75 },
    ])).toBe(200);
  });

  it("opens the first retained event associated with a Replay file", () => {
    const events = [{ id: "event-1", type: "prompt" }, { id: "event-2", type: "tool-call" }];
    expect(replayIndexForFile(events, [{ path: "src/app.ts", eventIds: ["event-2"] }], "src/app.ts")).toBe(1);
    expect(replayIndexForFile(events, [], "missing.ts")).toBe(-1);
  });
});
