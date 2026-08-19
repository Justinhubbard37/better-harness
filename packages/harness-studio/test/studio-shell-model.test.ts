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
  evidenceEnabled: false,
  experimentEnabled: false,
  historyEnabled: false,
  inspectorEnabled: false,
};

describe("Studio control-plane navigation", () => {
  it("offers exactly the four MVP workbenches with honest availability", () => {
    const destinations = studioDestinations(EMPTY);

    expect(destinations.map((destination) => destination.id)).toEqual([
      "overview",
      "inspector",
      "debugger",
      "compare",
    ]);
    expect(destinations.find((destination) => destination.id === "overview")).toMatchObject({ availability: "ready" });
    expect(destinations.find((destination) => destination.id === "debugger")).toMatchObject({
      availability: "foundation",
      status: "Harness required",
    });
    expect(destinations.find((destination) => destination.id === "compare")).toMatchObject({
      availability: "foundation",
      status: "Input required",
    });
    expect(capabilitySummary(EMPTY)).toEqual({ ready: 1, partial: 0, foundation: 3 });
  });

  it("routes configured artifacts to Debugger, Compare, and Inspector surfaces", () => {
    const config: StudioConfig = {
      aguiEnabled: true,
      evidenceEnabled: true,
      experimentEnabled: true,
      historyEnabled: true,
      inspectorEnabled: true,
    };

    expect(compareSurfaces(config)).toEqual(["bench", "results"]);
    expect(inspectorSurfaces(config)).toEqual(["workbench"]);
    expect(studioDestinations(config).find((destination) => destination.id === "debugger")).toMatchObject({
      availability: "ready",
      status: "Live runs",
    });
    expect(capabilitySummary(config)).toEqual({ ready: 4, partial: 0, foundation: 0 });
  });

  it("does not present a live AG-UI endpoint as retained Inspector evidence or a Compare input", () => {
    const config: StudioConfig = { ...EMPTY, aguiEnabled: true };

    expect(inspectorSurfaces(config)).toEqual([]);
    expect(compareSurfaces(config)).toEqual([]);
    expect(studioDestinations(config).find((destination) => destination.id === "inspector")).toMatchObject({
      availability: "foundation",
      status: "Report required",
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
