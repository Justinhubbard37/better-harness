export type StudioArea =
  | "overview"
  | "sessions"
  | "artifacts"
  | "debugger"
  | "compare";

export type StudioCompareSurface = "sessions" | "bench" | "results";
export type StudioInspectorSurface = "workbench";

export interface StudioConfig {
  aguiEnabled: boolean;
  artifactsEnabled: boolean;
  evidenceEnabled: boolean;
  experimentEnabled: boolean;
  historyEnabled: boolean;
  inspectorEnabled: boolean;
  workspaceConnected: boolean;
  sessionCount: number;
}

export type StudioAvailability = "ready" | "partial" | "foundation";

export interface StudioDestination {
  id: StudioArea;
  label: string;
  group: "Control" | "Observe" | "Run" | "Validate";
  availability: StudioAvailability;
  status: string;
}

export function studioDestinations(config: StudioConfig): readonly StudioDestination[] {
  const compareAvailable = config.experimentEnabled || config.evidenceEnabled;
  return [
    { id: "overview", label: "Overview", group: "Control", availability: "ready", status: "Control plane" },
    {
      id: "sessions",
      label: "Sessions",
      group: "Observe",
      availability: config.workspaceConnected ? "ready" : "partial",
      status: config.workspaceConnected ? `${config.sessionCount} session${config.sessionCount === 1 ? "" : "s"}` : "Open workspace",
    },
    {
      id: "artifacts",
      label: "Artifacts",
      group: "Observe",
      availability: config.artifactsEnabled ? "ready" : config.workspaceConnected ? "partial" : "foundation",
      status: config.artifactsEnabled ? "Session outputs" : config.workspaceConnected ? "Select a session" : "Workspace required",
    },
    {
      id: "debugger",
      label: "Debugger",
      group: "Run",
      availability: config.aguiEnabled ? "ready" : "foundation",
      status: config.aguiEnabled ? "Live runs" : "Harness required",
    },
    {
      id: "compare",
      label: "Compare",
      group: "Validate",
      availability: compareAvailable || config.sessionCount >= 2 ? "ready" : config.workspaceConnected ? "partial" : "foundation",
      status: config.sessionCount >= 2 ? "Session compare" : config.experimentEnabled ? "Harness Bench" : config.evidenceEnabled ? "Frozen results" : config.workspaceConnected ? "Choose 2 sessions" : "Workspace required",
    },
  ];
}

export function compareSurfaces(config: StudioConfig): readonly StudioCompareSurface[] {
  return [
    ...(config.sessionCount >= 2 ? ["sessions" as const] : []),
    ...(config.experimentEnabled ? ["bench" as const] : []),
    ...(config.evidenceEnabled ? ["results" as const] : []),
  ];
}

export function inspectorSurfaces(config: StudioConfig): readonly StudioInspectorSurface[] {
  return config.inspectorEnabled ? ["workbench"] : [];
}

export function capabilitySummary(config: StudioConfig): { ready: number; partial: number; foundation: number } {
  return studioDestinations(config).reduce(
    (summary, destination) => ({ ...summary, [destination.availability]: summary[destination.availability] + 1 }),
    { ready: 0, partial: 0, foundation: 0 },
  );
}
