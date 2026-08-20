import { describe, expect, it, vi } from "vitest";

import { createInspectorWorkspaceSessionProvider } from "../scripts/inspector-workspace-provider.mjs";

describe("Inspector workspace provider", () => {
  it("reuses the injected multi-provider collector and projects privacy-safe Session evidence", async () => {
    const collect = vi.fn(async () => ({
      providers: [
        { platform: "qoder", status: "ok", discovered: 1, included: 1 },
        { platform: "codex", status: "no-evidence", discovered: 0, included: 0 },
      ],
      sessions: [{
        sessionId: "session-123",
        platform: "qoder",
        firstSeen: "2026-08-20T09:00:00.000Z",
        lastSeen: "2026-08-20T09:05:00.000Z",
        prompts: [{ text: "Review the workspace", timestamp: "2026-08-20T09:00:00.000Z" }],
        promptCount: 1,
        assistantMessageCount: 1,
        toolCallCount: 1,
        toolActivity: {
          calls: [{ id: "A1", family: "inspect", actionLabel: "Read files", toolName: "Read", status: "observed", filePath: "README.md" }],
        },
        dialogue: { turns: [{ response: "Workspace reviewed." }] },
      }],
    }));
    const provider = createInspectorWorkspaceSessionProvider({
      collect,
      repoRootFor: () => "/private/repository",
      platforms: ["qoder", "codex"],
    });

    const result = await provider.discover("/private/repository/packages/app");

    expect(collect).toHaveBeenCalledWith(expect.objectContaining({
      workspace: "/private/repository/packages/app",
      repoRoot: "/private/repository",
      platforms: ["qoder", "codex"],
      includeToolTrace: true,
      includeDialogue: true,
    }));
    expect(result).toMatchObject({
      label: "repository",
      providers: [{ provider: "qoder", status: "ok" }, { provider: "codex", status: "no-evidence" }],
      sessions: [{
        summary: { id: "qoder:session-123", prompt: "Review the workspace", provider: "qoder", status: "observed", toolCallCount: 1 },
        debugger: { agent: "qoder", protocol: "Inspector normalized local evidence" },
      }],
    });
    expect(result.sessions[0].debugger.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "prompt", summary: "Review the workspace" }),
      expect.objectContaining({ kind: "explore", toolCalls: [expect.objectContaining({ name: "Read", resource: "README.md" })] }),
      expect.objectContaining({ kind: "response", summary: "Workspace reviewed." }),
    ]));
    expect(JSON.stringify(result)).not.toContain("/private/repository");
  });
});
