import { useEffect, useRef, useState } from "react";
import {
  isArtifactDataSnapshot,
  type ArtifactDataSnapshot,
  type ArtifactDescriptor,
  type ArtifactStructureNode,
  type MarkdownArtifactPayload,
  type MarkdownBlock,
  type MarkdownInline,
} from "../artifact-model.js";
import { HighlightedCode } from "./HighlightedCode.js";
import { studioApiError } from "./studio-api.js";

/**
 * Fence info strings name a language; the highlighter resolves a file
 * extension. Mapping the two is a Markdown concern, so it lives with the
 * Markdown renderer rather than widening the shared code model.
 */
const FENCE_LANGUAGE_HINTS: Record<string, string> = {
  "c#": "cs", "c++": "cpp", bash: "sh", console: "sh", csharp: "cs", golang: "go",
  javascript: "js", kotlin: "kt", markdown: "md", plaintext: "txt", python: "py",
  ruby: "rb", rust: "rs", shell: "sh", text: "txt", typescript: "ts", yml: "yaml", zsh: "sh",
};

export function MarkdownArtifactView({ artifact }: { artifact: ArtifactDescriptor }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ArtifactDataSnapshot>();
  const [failure, setFailure] = useState<string>();
  const documentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(artifact.adapter.snapshotUri, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(await studioApiError(response));
      const value: unknown = await response.json();
      if (!isArtifactDataSnapshot(value) || value.revisionId !== artifact.revision.id || value.payload.kind !== "markdown/v1") {
        throw new Error("Markdown snapshot contract is unsupported.");
      }
      setSnapshot(value);
      setFailure(undefined);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, [artifact.adapter.snapshotUri, artifact.revision.id]);

  if (failure !== undefined) return <p className="artifact-status" role="alert">{failure}</p>;
  if (snapshot === undefined || snapshot.payload.kind !== "markdown/v1") {
    return <p className="artifact-status" role="status">Adapting Markdown revision…</p>;
  }
  const payload: MarkdownArtifactPayload = snapshot.payload;
  const context: RenderContext = {
    resources: snapshot.resources,
    // Selecting an outline entry scrolls the document rather than writing a
    // fragment: Studio routes on the hash, so an anchor navigation would leave
    // the Artifacts workspace entirely.
    goTo: (slug) => {
      documentRef.current
        ?.querySelector(`[data-md-heading="${slug}"]`)
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
    },
  };

  return <div className="markdown-artifact-viewer">
    {snapshot.structure.length > 0 && <nav className="markdown-outline-rail" aria-label={`${artifact.label} outline`}>
      <h3>Outline</h3>
      <MarkdownOutline nodes={snapshot.structure} onSelect={context.goTo} />
    </nav>}
    <section className="markdown-document-region" aria-label={`${artifact.label} document`}>
      <div className="markdown-document-scroll" ref={documentRef} tabIndex={0}>
        <article className="markdown-document">
          {payload.blocks.map((block, index) => <MarkdownBlockView key={index} block={block} context={context} />)}
        </article>
      </div>
      <footer className="markdown-document-footer">
        <span>{snapshot.adapter.id}@{snapshot.adapter.version}</span>
        <MarkdownDiagnostics diagnostics={snapshot.diagnostics} />
      </footer>
    </section>
  </div>;
}

interface RenderContext {
  resources: ArtifactDataSnapshot["resources"];
  goTo: (slug: string) => void;
}

function MarkdownOutline(props: {
  nodes: readonly ArtifactStructureNode[];
  onSelect: (slug: string) => void;
}): React.JSX.Element {
  return <ul>
    {props.nodes.map((node) => <li key={node.address}>
      <button type="button" className={`markdown-outline-${node.kind}`} onClick={() => props.onSelect(node.id)}>{node.label}</button>
      {node.children !== undefined && node.children.length > 0 && <MarkdownOutline nodes={node.children} onSelect={props.onSelect} />}
    </li>)}
  </ul>;
}

function MarkdownBlockView({ block, context }: { block: MarkdownBlock; context: RenderContext }): React.JSX.Element {
  if (block.kind === "heading") {
    const Heading = `h${block.level}` as "h1";
    return <Heading data-md-heading={block.id}>
      <MarkdownInlineView nodes={block.children} context={context} />
    </Heading>;
  }
  if (block.kind === "paragraph") {
    return <p><MarkdownInlineView nodes={block.children} context={context} /></p>;
  }
  if (block.kind === "code") {
    return <div className="markdown-code-block" data-md-language={block.language ?? "plain"}>
      <HighlightedCode code={block.text} sourceHint={fenceHint(block.language)} />
    </div>;
  }
  if (block.kind === "quote") {
    return <blockquote>{block.blocks.map((child, index) => <MarkdownBlockView key={index} block={child} context={context} />)}</blockquote>;
  }
  if (block.kind === "list") return <MarkdownListView block={block} context={context} />;
  if (block.kind === "table") {
    return <div className="markdown-table-scroll">
      <table>
        <thead><tr>{block.head.map((cell, index) => <th key={index} style={{ textAlign: block.alignments[index] ?? "left" }}>
          <MarkdownInlineView nodes={cell} context={context} />
        </th>)}</tr></thead>
        <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index} style={{ textAlign: block.alignments[index] ?? "left" }}>
          <MarkdownInlineView nodes={cell} context={context} />
        </td>)}</tr>)}</tbody>
      </table>
    </div>;
  }
  if (block.kind === "thematicBreak") return <hr />;
  // Source Studio declined to interpret. It is text, never markup.
  return <pre className="markdown-raw-html" data-md-raw-html="true">{block.text}</pre>;
}

function MarkdownListView({
  block,
  context,
}: { block: Extract<MarkdownBlock, { kind: "list" }>; context: RenderContext }): React.JSX.Element {
  const items = block.items.map((item, index) => <li key={index} className={item.checked === undefined ? undefined : "markdown-task-item"}>
    {item.checked !== undefined && <input type="checkbox" checked={item.checked} disabled aria-label={item.checked ? "Completed task" : "Open task"} readOnly />}
    <MarkdownItemBody blocks={item.blocks} tight={block.tight} context={context} />
  </li>);
  const className = `markdown-list${block.tight ? " tight" : ""}`;
  return block.ordered
    ? <ol className={className} start={block.start}>{items}</ol>
    : <ul className={className}>{items}</ul>;
}

/** A tight item's single paragraph renders inline, so it stays on the marker's line. */
function MarkdownItemBody(props: {
  blocks: readonly MarkdownBlock[];
  tight: boolean;
  context: RenderContext;
}): React.JSX.Element {
  const [first, ...rest] = props.blocks;
  if (props.tight && first?.kind === "paragraph") {
    return <>
      <MarkdownInlineView nodes={first.children} context={props.context} />
      {rest.map((block, index) => <MarkdownBlockView key={index} block={block} context={props.context} />)}
    </>;
  }
  return <>{props.blocks.map((block, index) => <MarkdownBlockView key={index} block={block} context={props.context} />)}</>;
}

function MarkdownInlineView({
  nodes,
  context,
}: { nodes: readonly MarkdownInline[]; context: RenderContext }): React.JSX.Element {
  return <>{nodes.map((node, index) => <MarkdownInlineNode key={index} node={node} context={context} />)}</>;
}

function MarkdownInlineNode({ node, context }: { node: MarkdownInline; context: RenderContext }): React.JSX.Element {
  if (node.kind === "text") return <>{node.text}</>;
  if (node.kind === "code") return <code className="markdown-inline-code">{node.text}</code>;
  if (node.kind === "break") return <br />;
  if (node.kind === "emphasis") return <em><MarkdownInlineView nodes={node.children} context={context} /></em>;
  if (node.kind === "strong") return <strong><MarkdownInlineView nodes={node.children} context={context} /></strong>;
  if (node.kind === "strike") return <s><MarkdownInlineView nodes={node.children} context={context} /></s>;
  if (node.kind === "link") {
    if (node.href.startsWith("#")) {
      return <button type="button" className="markdown-anchor-link" title={node.title} onClick={() => context.goTo(node.href.slice(1))}>
        <MarkdownInlineView nodes={node.children} context={context} />
      </button>;
    }
    // The adapter already limited the scheme; the referrer and opener are
    // withheld here so an external target learns nothing about Studio.
    return <a href={node.href} title={node.title} target="_blank" rel="noreferrer noopener">
      <MarkdownInlineView nodes={node.children} context={context} />
    </a>;
  }
  if (node.kind === "image") {
    const resource = node.resourceId === undefined
      ? undefined
      : context.resources.find((candidate) => candidate.id === node.resourceId);
    // An image Studio declined to serve keeps its alt text, so the sentence
    // around it still reads.
    if (resource === undefined) {
      return <span className="markdown-image-unresolved" title={node.title}>{node.alt === "" ? "Image not shown" : node.alt}</span>;
    }
    return <img className="markdown-image" src={resource.uri} alt={node.alt} title={node.title} loading="lazy" />;
  }
  return <MarkdownInlineView nodes={node.children} context={context} />;
}

function MarkdownDiagnostics({ diagnostics }: { diagnostics: ArtifactDataSnapshot["diagnostics"] }): React.JSX.Element {
  if (diagnostics.length === 0) return <span>No diagnostics</span>;
  const worst = diagnostics.some((item) => item.level === "error")
    ? "error"
    : diagnostics.some((item) => item.level === "warning") ? "warning" : "info";
  return <details className={`artifact-diagnostics level-${worst}`}>
    <summary>{diagnostics.length} diagnostic{diagnostics.length === 1 ? "" : "s"}</summary>
    <ul>{diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}:${index}`}>
      <code>{diagnostic.code}</code><span>{diagnostic.message}</span>
    </li>)}</ul>
  </details>;
}

function fenceHint(language: string | undefined): string {
  if (language === undefined || language.trim() === "") return "block.txt";
  const normalized = language.trim().toLowerCase();
  return FENCE_LANGUAGE_HINTS[normalized] ?? normalized;
}
