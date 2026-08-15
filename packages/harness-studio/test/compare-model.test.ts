import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { HarnessCompareVerdict } from "@qoder-ai/harness";
import { CompareVerdictError, parseVerdict, summarizeVerdict } from "../src/app/compare-model.js";

export const FIXTURE_VERDICT = JSON.parse(
  await readFile(new URL("./fixtures/verdict.json", import.meta.url), "utf8"),
) as HarnessCompareVerdict;

describe("parseVerdict", () => {
  it("accepts the frozen harness-compare-result.v1 schema", () => {
    expect(parseVerdict(FIXTURE_VERDICT)).toBe(FIXTURE_VERDICT);
  });

  it("rejects other schemas and malformed documents", () => {
    expect(() => parseVerdict(null)).toThrow(CompareVerdictError);
    expect(() => parseVerdict({ schemaVersion: "harness-compare-result.v2" })).toThrow(
      /schemaVersion must equal 'harness-compare-result.v1'/,
    );
    expect(() =>
      parseVerdict({ schemaVersion: "harness-compare-result.v1", baseline: {} }),
    ).toThrow(/status must be one of/);
  });

  it("rejects malformed nested aggregates and trial grades before rendering", () => {
    expect(() => parseVerdict({
      ...FIXTURE_VERDICT,
      baseline: { ...FIXTURE_VERDICT.baseline, totalCostUsd: "not-a-number" },
    })).toThrow(/baseline.totalCostUsd/);
    expect(() => parseVerdict({
      ...FIXTURE_VERDICT,
      trials: [
        { ...FIXTURE_VERDICT.trials[0], grade: {} },
        FIXTURE_VERDICT.trials[1],
      ],
    })).toThrow(/trials\[0\]\.grade\.kind/);
  });
});

describe("summarizeVerdict", () => {
  it("derives the per-variant rows and trial rows the Compare view renders", () => {
    const summary = summarizeVerdict(FIXTURE_VERDICT);

    expect(summary.status).toBe("accept");
    expect(summary.rows).toEqual([
      {
        variant: "baseline",
        label: "H0 baseline",
        passedTrials: 0,
        completedTrials: 1,
        passRate: 0,
        meanScore: 42,
        infrastructureErrors: 0,
        totalCostUsd: 0.011,
        totalCredits: 1.5,
      },
      {
        variant: "candidate",
        label: "H1 candidate",
        passedTrials: 1,
        completedTrials: 1,
        passRate: 1,
        meanScore: 90,
        infrastructureErrors: 0,
        totalCostUsd: 0.014,
        totalCredits: 1.8,
      },
    ]);
    expect(summary.trials).toHaveLength(2);
    expect(summary.trials[1]).toEqual({
      variant: "candidate",
      trial: 1,
      harnessId: "readme-grounded",
      runtimeProfile: "qoder-default-v1",
      classification: "passed",
      durationMs: 74500,
      changedFiles: ["README.md"],
    });
  });
});
