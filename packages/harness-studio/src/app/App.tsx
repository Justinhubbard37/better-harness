import { useEffect, useState } from "react";
import { CompareView } from "./CompareView.js";
import { ExperimentView } from "./ExperimentView.js";
import { RunView } from "./RunView.js";

interface StudioConfig {
  aguiEnabled: boolean;
  evidenceEnabled: boolean;
  experimentEnabled: boolean;
}

type Tab = "experiment" | "run" | "compare";

export function App(): React.JSX.Element {
  const [config, setConfig] = useState<StudioConfig | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("run");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("api/config");
        const loaded = (await response.json()) as StudioConfig;
        if (!cancelled) {
          setConfig(loaded);
          setTab(loaded.experimentEnabled ? "experiment" : loaded.aguiEnabled ? "run" : "compare");
        }
      } catch {
        if (!cancelled) {
          setConfig({ aguiEnabled: false, evidenceEnabled: false, experimentEnabled: false });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (config === undefined) {
    return <main><p>Loading studio…</p></main>;
  }
  const navigation = (
    <nav className="studio-tabs" aria-label="Studio views">
      {config.experimentEnabled && (
        <button className={tab === "experiment" ? "active" : ""} onClick={() => setTab("experiment")}>Experiment</button>
      )}
      {config.aguiEnabled && (
        <button className={tab === "run" ? "active" : ""} onClick={() => setTab("run")}>Run</button>
      )}
      {config.evidenceEnabled && (
        <button className={tab === "compare" ? "active" : ""} onClick={() => setTab("compare")}>Compare</button>
      )}
    </nav>
  );
  if (tab === "experiment") {
    return <main className="experiment-mode"><ExperimentView navigation={navigation} /></main>;
  }
  return (
    <main>
      <header>
        <h1>Harness Studio</h1>
        {navigation}
      </header>
      {tab === "run" ? (
        config.aguiEnabled ? (
          <RunView aguiEndpoint="agui" />
        ) : (
          <p className="warning">
            No harness loaded. Start the studio with <code>--harness &lt;file.harness&gt;</code> to
            enable live runs.
          </p>
        )
      ) : (
        <CompareView />
      )}
    </main>
  );
}
