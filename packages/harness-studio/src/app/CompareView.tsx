import { useEffect, useState } from "react";
import { parseVerdict, summarizeVerdict, type CompareSummary } from "./compare-model.js";

type LoadState =
  | { phase: "loading" }
  | { phase: "missing"; detail: string }
  | { phase: "ready"; summary: CompareSummary };

export function CompareView(): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("api/evidence");
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error ?? `Evidence request failed (${response.status}).`);
        }
        const summary = summarizeVerdict(parseVerdict(await response.json()));
        if (!cancelled) {
          setState({ phase: "ready", summary });
        }
      } catch (error) {
        if (!cancelled) {
          setState({ phase: "missing", detail: error instanceof Error ? error.message : String(error) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.phase === "loading") {
    return <p>Loading compare evidence…</p>;
  }
  if (state.phase === "missing") {
    return (
      <section>
        <p className="warning">No compare evidence loaded: {state.detail}</p>
        <p>
          Produce one with <code>harness-compare run &lt;experiment.json&gt; --out &lt;dir&gt;</code>{" "}
          and start the studio with <code>--evidence &lt;dir&gt;</code>.
        </p>
      </section>
    );
  }
  const { summary } = state;
  return (
    <section>
      <p className="status-line">
        <strong className={`verdict-${summary.status}`}>{summary.status}</strong>: {summary.reason}
      </p>
      <p className="muted">
        Treatment axis {summary.treatmentAxis} · {summary.evidence.pairs} matched pair
        {summary.evidence.pairs === 1 ? "" : "s"} (min {summary.evidence.minimumMatchedPairs}) ·
        candidate {summary.evidence.candidateWins} / baseline {summary.evidence.baselineWins} /
        tied {summary.evidence.ties} · mean score delta {summary.evidence.meanScoreDelta}
      </p>
      <div className="table-scroll" role="region" aria-label="Variant comparison" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th>Variant</th>
              <th>Passed</th>
              <th>Pass rate</th>
              <th>Mean score</th>
              <th>Infra errors</th>
              <th>Cost (USD)</th>
              <th>Cost / trial</th>
              <th>Credits</th>
            </tr>
          </thead>
          <tbody>
            {summary.rows.map((row) => (
              <tr key={row.variant}>
                <th>{row.label}</th>
                <td>{row.passedTrials}/{row.completedTrials}</td>
                <td>{(row.passRate * 100).toFixed(0)}%</td>
                <td>{row.meanScore}</td>
                <td>{row.infrastructureErrors}</td>
                <td>{row.totalCostUsd.toFixed(4)}</td>
                <td>{row.costPerCompletedTrialUsd.toFixed(4)}</td>
                <td>{row.totalCredits.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Trials</h3>
      <div className="table-scroll" role="region" aria-label="Trial details" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th>Variant</th>
              <th>#</th>
              <th>Harness</th>
              <th>Profile</th>
              <th>Outcome</th>
              <th>Duration</th>
              <th>Changed files</th>
            </tr>
          </thead>
          <tbody>
            {summary.trials.map((trial) => (
              <tr key={`${trial.variant}-${trial.trial}`}>
                <td>{trial.variant}</td>
                <td>{trial.trial}</td>
                <td>{trial.harnessId}</td>
                <td>{trial.runtimeProfile}</td>
                <td>{trial.classification}</td>
                <td>{(trial.durationMs / 1000).toFixed(1)}s</td>
                <td>{trial.changedFiles.join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">Manifest {summary.manifestHash}</p>
    </section>
  );
}
