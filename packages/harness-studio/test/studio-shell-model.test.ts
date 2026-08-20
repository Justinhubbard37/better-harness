import { describe, expect, it } from "vitest";
import {
  capabilitySummary,
  compareSurfaces,
  inspectorSurfaces,
  studioDestinations,
  type StudioConfig,
} from "../src/app/studio-shell-model.js";

const EMPTY: StudioConfig = {
  aguiEnabled: false,
  artifactsEnabled: false,
  evidenceEnabled: false,
  experimentEnabled: false,
  historyEnabled: false,
  inspectorEnabled: false,
  workspaceConnected: false,
  sessionCount: 0,
};

describe("Studio control-plane navigation", () => {
  it("offers exactly the five workbenches with honest availability", () => {
    const destinations = studioDestinations(EMPTY);

    expect(destinations.map((destination) => destination.id)).toEqual([
      "overview",
      "sessions",
      "artifacts",
      "debugger",
      "compare",
    ]);
    expect(destinations.find((destination) => destination.id === "overview")).toMatchObject({ availability: "ready" });
    expect(destinations.find((destination) => destination.id === "sessions")).toMatchObject({
      availability: "partial",
      status: "Open workspace",
    });
    expect(destinations.find((destination) => destination.id === "artifacts")).toMatchObject({
      availability: "foundation",
      status: "Workspace required",
    });
    expect(destinations.find((destination) => destination.id === "debugger")).toMatchObject({
      availability: "foundation",
      status: "Harness required",
    });
    expect(destinations.find((destination) => destination.id === "compare")).toMatchObject({
      availability: "foundation",
      status: "Workspace required",
    });
    expect(capabilitySummary(EMPTY)).toEqual({ ready: 1, partial: 1, foundation: 3 });
  });

  it("routes configured artifacts to Debugger, Compare, and Inspector surfaces", () => {
    const config: StudioConfig = {
      aguiEnabled: true,
      artifactsEnabled: true,
      evidenceEnabled: true,
      experimentEnabled: true,
      historyEnabled: true,
      inspectorEnabled: true,
      workspaceConnected: true,
      sessionCount: 3,
    };

    expect(compareSurfaces(config)).toEqual(["sessions", "bench", "results"]);
    expect(inspectorSurfaces(config)).toEqual(["workbench"]);
    expect(studioDestinations(config).find((destination) => destination.id === "debugger")).toMatchObject({
      availability: "ready",
      status: "Live runs",
    });
    expect(capabilitySummary(config)).toEqual({ ready: 5, partial: 0, foundation: 0 });
  });

  it("treats an artifact directory as independent of every other input", () => {
    const config: StudioConfig = { ...EMPTY, artifactsEnabled: true };

    expect(studioDestinations(config).find((destination) => destination.id === "artifacts")).toMatchObject({
      availability: "ready",
      status: "Session outputs",
    });
    // Artifacts must not imply retained Inspector evidence or a Compare input.
    expect(inspectorSurfaces(config)).toEqual([]);
    expect(compareSurfaces(config)).toEqual([]);
  });

  it("does not present a live AG-UI endpoint as retained Inspector evidence or a Compare input", () => {
    const config: StudioConfig = { ...EMPTY, aguiEnabled: true };

    expect(inspectorSurfaces(config)).toEqual([]);
    expect(compareSurfaces(config)).toEqual([]);
    expect(studioDestinations(config).find((destination) => destination.id === "sessions")).toMatchObject({
      availability: "partial",
      status: "Open workspace",
    });
    expect(studioDestinations(config).find((destination) => destination.id === "compare")).toMatchObject({
      availability: "foundation",
    });
  });

  it("enables Compare from frozen evidence alone", () => {
    const config: StudioConfig = { ...EMPTY, evidenceEnabled: true };

    expect(compareSurfaces(config)).toEqual(["results"]);
    expect(studioDestinations(config).find((destination) => destination.id === "compare")).toMatchObject({
      availability: "ready",
      status: "Frozen results",
    });
  });
});
