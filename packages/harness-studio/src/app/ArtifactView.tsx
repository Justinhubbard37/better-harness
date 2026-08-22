import { useEffect, useState } from "react";
import { Minus } from "@phosphor-icons/react/Minus";
import { Plus } from "@phosphor-icons/react/Plus";
import {
  isArtifactDataSnapshot,
  type ArtifactDataSnapshot,
  type ArtifactDescriptor,
  type PptxElement,
  type PptxSlideSnapshot,
} from "../artifact-model.js";
import { ArtifactCodeView } from "./ArtifactCodeView.js";
import { ArtifactPreviewHost } from "./ArtifactPreviewHost.js";
import { MarkdownArtifactView } from "./MarkdownArtifactView.js";
import { studioApiError } from "./studio-api.js";

export interface ArtifactViewProviderContext {
  artifact: ArtifactDescriptor;
  liveGeneration: number;
}

/** Composition contract for one browser-side Artifact renderer family. */
export interface ArtifactViewProvider {
  id: string;
  matches: (artifact: ArtifactDescriptor) => boolean;
  render: (context: ArtifactViewProviderContext) => React.JSX.Element;
}

const TEXT_RENDERER_IDS = new Set(["studio.code", "studio.diff", "studio.json", "studio.text"]);

export const ARTIFACT_VIEW_PROVIDERS: readonly ArtifactViewProvider[] = Object.freeze([
  {
    id: "studio.react-preview",
    matches: (artifact) => artifact.renderer.id === "studio.react-preview" && artifact.backing === "code",
    render: ({ artifact, liveGeneration }) => <ArtifactPreviewHost artifact={artifact} liveGeneration={liveGeneration} />,
  },
  {
    id: "qoder-canvas",
    matches: (artifact) => artifact.renderer.type === "qoder-canvas" && artifact.renderer.viewUri !== undefined,
    render: ({ artifact }) => <iframe key={artifact.revision.digest} className="artifact-frame" title={`Artifact preview: ${artifact.label}`} src={artifact.renderer.viewUri} sandbox="allow-scripts" referrerPolicy="no-referrer" />,
  },
  {
    id: "studio.markdown",
    matches: (artifact) => artifact.renderer.id === "studio.markdown",
    render: ({ artifact }) => <MarkdownArtifactView key={artifact.revision.digest} artifact={artifact} />,
  },
  {
    id: "studio.pptx-dom",
    matches: (artifact) => artifact.renderer.id === "studio.pptx-dom",
    render: ({ artifact }) => <PptxArtifactView key={artifact.revision.digest} artifact={artifact} />,
  },
  {
    id: "studio.svg",
    matches: (artifact) => artifact.renderer.id === "studio.svg",
    render: ({ artifact }) => <SvgArtifactView key={artifact.revision.digest} artifact={artifact} />,
  },
  {
    id: "studio.image",
    matches: (artifact) => artifact.renderer.id === "studio.image",
    render: ({ artifact }) => <div className="artifact-image-stage"><img key={artifact.revision.digest} src={artifact.revision.content.uri} alt={artifact.label} /></div>,
  },
  {
    id: "studio.text-family",
    matches: (artifact) => TEXT_RENDERER_IDS.has(artifact.renderer.id),
    render: ({ artifact }) => <TextArtifactView key={artifact.revision.digest} artifact={artifact} />,
  },
]);

export function resolveArtifactViewProvider(
  artifact: ArtifactDescriptor,
  providers: readonly ArtifactViewProvider[] = ARTIFACT_VIEW_PROVIDERS,
): ArtifactViewProvider | undefined {
  return providers.find((provider) => provider.matches(artifact));
}

/** Host-owned dispatch; the server-selected renderer remains authoritative. */
export function ArtifactView(props: ArtifactViewProviderContext): React.JSX.Element {
  if (props.artifact.renderer.status === "ready") {
    const provider = resolveArtifactViewProvider(props.artifact);
    if (provider !== undefined) return provider.render(props);
  }
  return <p className="artifact-status" role="status">{props.artifact.renderer.reason ?? `No renderer is available for this artifact (${props.artifact.renderer.id}).`}</p>;
}

function SvgArtifactView({ artifact }: { artifact: ArtifactDescriptor }): React.JSX.Element {
  const [source, setSource] = useState<string>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void fetch(artifact.revision.content.uri, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`SVG content failed (${response.status}).`);
      setSource(await response.text());
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, [artifact.revision.content.uri]);
  if (failure !== undefined) return <p className="artifact-status" role="alert">{failure}</p>;
  if (source === undefined) return <p className="artifact-status" role="status">Loading SVG preview…</p>;
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`;
  return <iframe className="artifact-frame" title={`SVG preview: ${artifact.label}`} srcDoc={`${policy}${source}`} sandbox="" referrerPolicy="no-referrer" />;
}

function TextArtifactView({ artifact }: { artifact: ArtifactDescriptor }): React.JSX.Element {
  const [content, setContent] = useState<string>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
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

function PptxArtifactView({ artifact }: { artifact: ArtifactDescriptor }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ArtifactDataSnapshot>();
  const [failure, setFailure] = useState<string>();
  const [slideIndex, setSlideIndex] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [selectedAddress, setSelectedAddress] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void fetch(artifact.adapter.snapshotUri, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(await studioApiError(response));
      const value: unknown = await response.json();
      if (!isArtifactDataSnapshot(value) || value.revisionId !== artifact.revision.id || value.payload.kind !== "pptx/v1") {
        throw new Error("PPTX snapshot contract is unsupported.");
      }
      setSnapshot(value);
      setFailure(undefined);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, [artifact.adapter.snapshotUri, artifact.revision.id]);
  if (failure !== undefined) return <p className="artifact-status" role="alert">{failure}</p>;
  if (snapshot === undefined || snapshot.payload.kind !== "pptx/v1") return <p className="artifact-status" role="status">Adapting PPTX revision…</p>;
  const payload = snapshot.payload;
  const active = payload.slides[Math.min(slideIndex, payload.slides.length - 1)];
  if (active === undefined) return <p className="artifact-status" role="alert">The PPTX snapshot has no slides.</p>;
  const outline = snapshot.structure.length === payload.slides.length ? snapshot.structure : [];
  const activeOutline = outline[Math.min(slideIndex, outline.length - 1)];
  const selectAddress = (address: string): void => setSelectedAddress((current) => current === address ? undefined : address);
  return <div className="pptx-artifact-viewer">
    <nav className="pptx-slide-rail" aria-label="Slides">
      {payload.slides.map((slide, index) => <button key={slide.id} type="button" className={index === slideIndex ? "selected" : undefined} aria-current={index === slideIndex} onClick={() => { setSlideIndex(index); setSelectedAddress(undefined); }}>
        <span className="pptx-slide-thumb" aria-hidden="true">{index + 1}</span><small>{slide.label}</small>
      </button>)}
    </nav>
    <section className="pptx-stage-region" aria-label={`${active.label} preview`}>
      <div className="pptx-view-toolbar">
        <span>{active.label}{active.notesPresent ? " · Notes" : ""}</span>
        <div role="group" aria-label="Slide zoom"><button type="button" aria-label="Zoom out" disabled={zoom <= 50} onClick={() => setZoom((value) => Math.max(50, value - 25))}><Minus aria-hidden="true" size={14} /></button><output>{zoom}%</output><button type="button" aria-label="Zoom in" disabled={zoom >= 200} onClick={() => setZoom((value) => Math.min(200, value + 25))}><Plus aria-hidden="true" size={14} /></button></div>
      </div>
      <div className="pptx-stage-scroll">
        <PptxSlide slide={active} width={payload.width} height={payload.height} zoom={zoom} resources={snapshot.resources} selectedAddress={selectedAddress} />
      </div>
      <footer className="pptx-diagnostics">
        <span>{snapshot.adapter.id}@{snapshot.adapter.version}</span>
        <ArtifactDiagnostics diagnostics={snapshot.diagnostics} />
      </footer>
    </section>
    {activeOutline !== undefined && (activeOutline.children ?? []).length > 0 && <aside className="pptx-outline-pane" aria-label={`${active.label} outline`}>
      <h3>Outline</h3>
      <ul>
        {(activeOutline.children ?? []).map((node) => <li key={node.id}>
          <button type="button" className={node.address === selectedAddress ? "selected" : undefined} aria-pressed={node.address === selectedAddress} onClick={() => selectAddress(node.address)}>
            <strong>{node.label}</strong><small>{node.kind}</small>
          </button>
        </li>)}
      </ul>
    </aside>}
  </div>;
}

function ArtifactDiagnostics({ diagnostics }: { diagnostics: ArtifactDataSnapshot["diagnostics"] }): React.JSX.Element {
  if (diagnostics.length === 0) return <span>No diagnostics</span>;
  const worst = diagnostics.some((item) => item.level === "error")
    ? "error"
    : diagnostics.some((item) => item.level === "warning") ? "warning" : "info";
  return <details className={`artifact-diagnostics level-${worst}`}>
    <summary>{diagnostics.length} diagnostic{diagnostics.length === 1 ? "" : "s"}</summary>
    <ul>
      {diagnostics.map((item, index) => <li key={`${item.code}:${index}`} className={`level-${item.level}`}>
        <strong>{item.code}</strong><span>{item.message}</span>{item.address !== undefined && <code>{item.address}</code>}
      </li>)}
    </ul>
  </details>;
}

function PptxSlide(props: { slide: PptxSlideSnapshot; width: number; height: number; zoom: number; resources: ArtifactDataSnapshot["resources"]; selectedAddress?: string }): React.JSX.Element {
  return <div className="pptx-slide" style={{ aspectRatio: `${props.width} / ${props.height}`, width: `${props.zoom}%`, backgroundColor: props.slide.background ?? "var(--color-document-paper)" }}>
    {props.slide.elements.map((element) => <PptxSlideElement key={element.id} element={element} slideWidth={props.width} slideHeight={props.height} resources={props.resources} selected={element.address === props.selectedAddress} />)}
  </div>;
}

function PptxSlideElement(props: { element: PptxElement; slideWidth: number; slideHeight: number; resources: ArtifactDataSnapshot["resources"]; selected: boolean }): React.JSX.Element {
  const element = props.element;
  const style = {
    left: `${element.x / props.slideWidth * 100}%`,
    top: `${element.y / props.slideHeight * 100}%`,
    width: `${element.width / props.slideWidth * 100}%`,
    height: `${element.height / props.slideHeight * 100}%`,
    ...(element.rotation === undefined ? {} : { transform: `rotate(${element.rotation}deg)` }),
  };
  const selection = props.selected ? " selected" : "";
  if (element.kind === "image") {
    const resource = props.resources.find((candidate) => candidate.id === element.resourceId);
    return <img className={`pptx-slide-element pptx-slide-image${selection}`} data-artifact-address={element.address} style={style} src={resource?.uri} alt={element.alt ?? element.name} />;
  }
  return <div className={`pptx-slide-element pptx-slide-shape${selection}`} data-artifact-address={element.address} style={{ ...style, backgroundColor: element.fill ?? "transparent", borderColor: element.line ?? "transparent" }}>
    {element.paragraphs.map((paragraph, paragraphIndex) => <p key={paragraphIndex} style={{ textAlign: paragraph.alignment }}>
      {paragraph.runs.map((run, runIndex) => <span key={runIndex} style={{
        ...(run.fontFamily === undefined ? {} : { fontFamily: `${JSON.stringify(run.fontFamily)}, system-ui, sans-serif` }),
        ...(run.fontSizePoints === undefined ? {} : { fontSize: `${run.fontSizePoints / (props.slideWidth / 12_700) * 100}cqw` }),
        ...(run.color === undefined ? {} : { color: run.color }),
        ...(run.bold === true ? { fontWeight: 700 } : {}),
        ...(run.italic === true ? { fontStyle: "italic" } : {}),
      }}>{run.text}</span>)}
    </p>)}
  </div>;
}
