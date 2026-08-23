import { useEffect, useState } from "react";
import { ArtifactCodeView } from "../ArtifactCodeView.js";
import type { ArtifactSurfaceMountContext } from "./ArtifactSurface.js";

export function TextArtifactView({ artifact }: ArtifactSurfaceMountContext): React.JSX.Element {
  const [content, setContent] = useState<string>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    setContent(undefined);
    setFailure(undefined);
    void fetch(artifact.revision.content.uri, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Artifact content failed (${response.status}).`);
      setContent(await response.text());
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, [artifact.revision.content.uri]);

  if (failure !== undefined) return <p className="artifact-status" role="alert">{failure}</p>;
  if (content === undefined) return <p className="artifact-status" role="status">Loading preview…</p>;
  if (artifact.renderer.id === "studio.diff") {
    return <ArtifactCodeView mode="diff" patch={content} label={`Artifact patch: ${artifact.label}`} />;
  }
  return <ArtifactCodeView mode="source" content={content} sourceHint={artifact.label} className="artifact-code-preview" label={`Artifact source: ${artifact.label}`} />;
}
