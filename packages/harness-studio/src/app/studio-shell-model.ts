export type StudioArea =
  | "overview"
  | "inspector"
  | "artifacts"
  | "debugger"
  | "compare";

export type StudioCompareSurface = "bench" | "results";
export type StudioInspectorSurface = "workbench";

export interface StudioConfig {
  aguiEnabled: boolean;
  artifactsEnabled: boolean;
  evidenceEnabled: boolean;
  experimentEnabled: boolean;
  historyEnabled: boolean;
  inspectorEnabled: boolean;
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
      id: "inspector",
      label: "Inspector",
      group: "Observe",
      availability: config.inspectorEnabled ? "ready" : "foundation",
      status: config.inspectorEnabled ? "Evidence workbench" : "Report required",
    },
    {
      id: "artifacts",
      label: "Artifacts",
      group: "Observe",
      availability: config.artifactsEnabled ? "ready" : "partial",
      status: config.artifactsEnabled ? "Run outputs" : "Analyze artifacts",
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
      availability: compareAvailable ? "ready" : "foundation",
      status: config.experimentEnabled ? "Harness Bench" : config.evidenceEnabled ? "Frozen results" : "Input required",
    },
  ];
}

export function compareSurfaces(config: StudioConfig): readonly StudioCompareSurface[] {
  return [
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
