import { useEffect, useRef, useState } from "react";
import {
  isArtifactBuildSnapshot,
  type ArtifactBuildSnapshot,
  type ArtifactDescriptor,
} from "../artifact-model.js";
import { HighlightedCode } from "./HighlightedCode.js";

type PreviewState = "compiling" | "starting" | "ready" | "compile-failed" | "runtime-failed";

export function ArtifactPreviewHost(props: {
  artifact: ArtifactDescriptor;
  liveGeneration: number;
}): React.JSX.Element {
  const [surface, setSurface] = useState<"preview" | "source">("preview");
  const [build, setBuild] = useState<ArtifactBuildSnapshot>();
  const [previewState, setPreviewState] = useState<PreviewState>("compiling");
  const [failure, setFailure] = useState<string>();
  const [source, setSource] = useState<string>();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const channelRef = useRef<MessageChannel | undefined>(undefined);
  const requestRef = useRef(0);

  useEffect(() => {
    const buildUri = props.artifact.build?.snapshotUri;
    const request = ++requestRef.current;
    const controller = new AbortController();
    channelRef.current?.port1.close();
    channelRef.current?.port2.close();
    channelRef.current = undefined;
    setPreviewState("compiling");
    setFailure(undefined);
    setBuild(undefined);
    if (buildUri === undefined) {
      setPreviewState("compile-failed");
      setFailure("The code-backed artifact has no build reference.");
      return () => controller.abort();
    }
    void fetch(buildUri, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(await studioBuildError(response));
      const value: unknown = await response.json();
      if (!isArtifactBuildSnapshot(value)
        || value.artifactId !== props.artifact.id
        || value.revisionId !== props.artifact.revision.id) {
        throw new Error("Artifact build snapshot contract is unsupported.");
      }
      if (request !== requestRef.current) return;
      setBuild(value);
      if (value.status === "failed") {
        setPreviewState("compile-failed");
        setFailure(value.diagnostics[0]?.message ?? "Artifact compilation failed.");
      } else {
        setPreviewState("starting");
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && request === requestRef.current) {
        setPreviewState("compile-failed");
        setFailure(error instanceof Error ? error.message : String(error));
      }
    });
    return () => controller.abort();
  }, [props.artifact.build?.snapshotUri, props.artifact.id, props.artifact.revision.id, props.liveGeneration]);

  useEffect(() => {
    const controller = new AbortController();
    setSource(undefined);
    void fetch(props.artifact.revision.content.uri, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Artifact source failed (${response.status}).`);
      setSource(await response.text());
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, [props.artifact.revision.content.uri]);

  useEffect(() => () => {
    channelRef.current?.port1.close();
    channelRef.current?.port2.close();
  }, []);

  const initializePreview = (): void => {
    const frame = frameRef.current;
    if (build?.status !== "ready" || build.previewUri === undefined || frame?.contentWindow == null) return;
    channelRef.current?.port1.close();
    channelRef.current?.port2.close();
    const channel = new MessageChannel();
    channelRef.current = channel;
    const expected = {
      artifactId: build.artifactId,
      revisionId: build.revisionId,
      buildId: build.buildId,
      runtimeId: build.runtime.id,
    };
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (!isRuntimeMessage(message, expected)) return;
      if (message.type === "renderCompleted") {
        setPreviewState("ready");
        setFailure(undefined);
      } else {
        setPreviewState("runtime-failed");
        setFailure(message.message ?? "Artifact preview failed at runtime.");
      }
    };
    channel.port1.start();
    setPreviewState("starting");
    const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    frame.contentWindow.postMessage({ ...expected, type: "runtime.init", theme }, "*", [channel.port2]);
  };

  return <section className="artifact-runtime-host" aria-label={`Artifact view: ${props.artifact.label}`}>
    <div className="artifact-runtime-tabs" role="tablist" aria-label="Artifact view mode">
      <button type="button" role="tab" aria-selected={surface === "preview"} onClick={() => setSurface("preview")}>Preview</button>
      <button type="button" role="tab" aria-selected={surface === "source"} onClick={() => setSurface("source")}>Source</button>
      <span>{build === undefined ? "No build" : `${shortBuild(build.buildId)} · build ${build.sequence}`}</span>
    </div>
    {surface === "source"
      ? <div className="artifact-code-preview">{source === undefined
        ? <p className="artifact-status" role="status">Loading source…</p>
        : <HighlightedCode code={source} sourceHint={props.artifact.label} label={`Artifact source: ${props.artifact.label}`} />}</div>
      : build?.status === "ready" && build.previewUri !== undefined
        ? <iframe
          key={build.buildId}
          ref={frameRef}
          className="artifact-frame artifact-runtime-frame"
          title={`Live artifact preview: ${props.artifact.label}`}
          src={build.previewUri}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          onLoad={initializePreview}
        />
        : <ArtifactBuildFailure build={build} failure={failure} state={previewState} />}
    <p className={`artifact-runtime-status state-${previewState}`} role={previewState.endsWith("failed") ? "alert" : "status"} aria-live="polite">
      {previewStatus(previewState, failure)}
    </p>
  </section>;
}

function ArtifactBuildFailure(props: {
  build?: ArtifactBuildSnapshot;
  failure?: string;
  state: PreviewState;
}): React.JSX.Element {
  if (props.state === "compiling" || props.state === "starting") {
    return <p className="artifact-status" role="status">{previewStatus(props.state)}</p>;
  }
  return <div className="artifact-build-diagnostics" role="alert">
    <strong>{props.state === "compile-failed" ? "Build failed" : "Preview failed"}</strong>
    <p>{props.failure ?? "The artifact could not be rendered."}</p>
    {(props.build?.diagnostics.length ?? 0) > 0 && <ol>{props.build!.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.source ?? "build"}:${index}`}>
      <code>{diagnostic.source ?? "artifact"}{diagnostic.line === undefined ? "" : `:${diagnostic.line}:${diagnostic.column ?? 0}`}</code>
      <span>{diagnostic.message}</span>
    </li>)}</ol>}
  </div>;
}

function isRuntimeMessage(
  value: unknown,
  expected: { artifactId: string; revisionId: string; buildId: string; runtimeId: string },
): value is typeof expected & { type: "renderCompleted" | "renderFailed"; message?: string } {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (message.type === "renderCompleted" || message.type === "renderFailed")
    && message.artifactId === expected.artifactId
    && message.revisionId === expected.revisionId
    && message.buildId === expected.buildId
    && message.runtimeId === expected.runtimeId
    && (message.message === undefined || typeof message.message === "string");
}

function previewStatus(state: PreviewState, failure?: string): string {
  if (state === "compiling") return "Compiling Artifact revision…";
  if (state === "starting") return "Starting sandboxed Preview…";
  if (state === "ready") return "Preview rendered from the current build.";
  return failure ?? (state === "compile-failed" ? "Artifact build failed." : "Artifact Preview failed.");
}

function shortBuild(value: string): string {
  return `${value.slice(7, 15)}…`;
}

async function studioBuildError(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (typeof payload === "object" && payload !== null && typeof (payload as { error?: unknown }).error === "string") {
      return (payload as { error: string }).error;
    }
  } catch {
    // Fall through to the bounded status text.
  }
  return `Artifact build failed (${response.status}).`;
}
