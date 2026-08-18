import { describe, expect, it } from "vitest";
import {
  capabilitySummary,
  experimentSurfaces,
  inspectorSurfaces,
  studioDestinations,
  type StudioConfig,
} from "../src/app/studio-shell-model.js";

const EMPTY: StudioConfig = {
  aguiEnabled: false,
  evidenceEnabled: false,
  experimentEnabled: false,
  historyEnabled: false,
  inspectorEnabled: false,
};

describe("Studio control-plane navigation", () => {
  it("keeps product objects stable while deriving honest availability", () => {
    const destinations = studioDestinations(EMPTY);

    expect(destinations.map((destination) => destination.id)).toEqual([
      "overview",
      "inspector",
      "harnesses",
      "task-suites",
      "experiments",
      "registry",
    ]);
    expect(destinations.find((destination) => destination.id === "overview")).toMatchObject({ availability: "ready" });
    expect(destinations.find((destination) => destination.id === "registry")).toMatchObject({
      availability: "foundation",
      status: "Not implemented",
    });
    expect(capabilitySummary(EMPTY)).toEqual({ ready: 1, partial: 0, foundation: 5 });
  });

  it("routes configured artifacts to contextual experiment and Inspector surfaces", () => {
    const config: StudioConfig = {
      aguiEnabled: true,
      evidenceEnabled: true,
      experimentEnabled: true,
      historyEnabled: true,
      inspectorEnabled: true,
    };

    expect(experimentSurfaces(config)).toEqual(["experiment", "live-run", "results"]);
    expect(inspectorSurfaces(config)).toEqual(["workbench"]);
    expect(studioDestinations(config).find((destination) => destination.id === "task-suites")).toMatchObject({
      availability: "partial",
      status: "Single task bound",
    });
    expect(capabilitySummary(config)).toEqual({ ready: 3, partial: 2, foundation: 1 });
  });

  it("does not present a live AG-UI endpoint as retained Inspector evidence", () => {
    const config: StudioConfig = { ...EMPTY, aguiEnabled: true };

    expect(inspectorSurfaces(config)).toEqual([]);
    expect(studioDestinations(config).find((destination) => destination.id === "inspector")).toMatchObject({
      availability: "foundation",
      status: "Report required",
    });
    expect(experimentSurfaces(config)).toEqual(["live-run"]);
  });
});
