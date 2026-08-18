export type StudioArea =
  | "overview"
  | "inspector"
  | "harnesses"
  | "task-suites"
  | "experiments"
  | "registry";

export type StudioExperimentSurface = "experiment" | "live-run" | "results";
export type StudioInspectorSurface = "workbench" | "session";

export interface StudioConfig {
  aguiEnabled: boolean;
  evidenceEnabled: boolean;
  experimentEnabled: boolean;
  historyEnabled: boolean;
  inspectorEnabled: boolean;
}

export type StudioAvailability = "ready" | "partial" | "foundation";

export interface StudioDestination {
  id: StudioArea;
  label: string;
  group: "Control" | "Observe" | "Compose" | "Validate" | "Govern";
  availability: StudioAvailability;
  status: string;
}

export function studioDestinations(config: StudioConfig): readonly StudioDestination[] {
  const inspectorAvailable = config.inspectorEnabled || config.aguiEnabled;
  const experimentAvailable = config.experimentEnabled || config.aguiEnabled || config.evidenceEnabled;
  return [
    { id: "overview", label: "Overview", group: "Control", availability: "ready", status: "Control plane" },
    {
      id: "inspector",
      label: "Inspector",
      group: "Observe",
      availability: inspectorAvailable ? "ready" : "foundation",
      status: config.inspectorEnabled ? "Evidence workbench" : config.aguiEnabled ? "Session debugger" : "Report required",
    },
    {
      id: "harnesses",
      label: "Harnesses",
      group: "Compose",
      availability: config.aguiEnabled || config.experimentEnabled ? "partial" : "foundation",
      status: config.aguiEnabled || config.experimentEnabled ? "Loaded context" : "Source required",
    },
    {
      id: "task-suites",
      label: "Task Suites",
      group: "Compose",
      availability: config.experimentEnabled ? "partial" : "foundation",
      status: config.experimentEnabled ? "Single task bound" : "Foundation",
    },
    {
      id: "experiments",
      label: "Experiments",
      group: "Validate",
      availability: experimentAvailable ? "ready" : "foundation",
      status: config.experimentEnabled ? "Harness Bench" : config.aguiEnabled ? "Live run" : config.evidenceEnabled ? "Frozen results" : "Input required",
    },
    {
      id: "registry",
      label: "Registry",
      group: "Govern",
      availability: "foundation",
      status: "Not implemented",
    },
  ];
}

export function experimentSurfaces(config: StudioConfig): readonly StudioExperimentSurface[] {
  return [
    ...(config.experimentEnabled ? ["experiment" as const] : []),
    ...(config.aguiEnabled ? ["live-run" as const] : []),
    ...(config.evidenceEnabled ? ["results" as const] : []),
  ];
}

export function inspectorSurfaces(config: StudioConfig): readonly StudioInspectorSurface[] {
  return [
    ...(config.inspectorEnabled ? ["workbench" as const] : []),
    ...(config.aguiEnabled ? ["session" as const] : []),
  ];
}

export function capabilitySummary(config: StudioConfig): { ready: number; partial: number; foundation: number } {
  return studioDestinations(config).reduce(
    (summary, destination) => ({ ...summary, [destination.availability]: summary[destination.availability] + 1 }),
    { ready: 0, partial: 0, foundation: 0 },
  );
}
