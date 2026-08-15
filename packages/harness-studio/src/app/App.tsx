import { useEffect, useState } from "react";
import { CompareView } from "./CompareView.js";
import { RunView } from "./RunView.js";

interface StudioConfig {
  aguiEnabled: boolean;
  evidenceEnabled: boolean;
}

type Tab = "run" | "compare";

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
          setTab(loaded.aguiEnabled ? "run" : "compare");
        }
      } catch {
        if (!cancelled) {
          setConfig({ aguiEnabled: false, evidenceEnabled: false });
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
  return (
    <main>
      <header>
        <h1>Harness Studio</h1>
        <nav>
          <button className={tab === "run" ? "active" : ""} onClick={() => setTab("run")}>
            Run
          </button>
          <button className={tab === "compare" ? "active" : ""} onClick={() => setTab("compare")}>
            Compare
          </button>
        </nav>
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
