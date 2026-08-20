import { useMemo } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import type { DebuggerDiff } from "./session-debugger-model.js";
import { buildDebuggerPatch } from "./code-rendering-model.js";

export default function StudioDiff(props: { diff?: DebuggerDiff; patch?: string }): React.JSX.Element {
  const patch = props.patch ?? (props.diff === undefined ? "" : buildDebuggerPatch(props.diff));
  const fileDiff = useMemo(() => parseFileDiff(patch), [patch]);
  if (fileDiff === undefined) {
    return <pre className="studio-diff-fallback">{patch}</pre>;
  }
  return <div className="studio-diff-renderer" data-code-diff="pierre">
    <FileDiff
      fileDiff={fileDiff}
      disableWorkerPool
      options={{
        diffStyle: "split",
        disableFileHeader: true,
        hunkSeparators: "line-info-basic",
        lineDiffType: "word",
        overflow: "scroll",
        stickyHeader: false,
        theme: "github-light",
        themeType: "light",
        unsafeCSS: pierreStudioCss,
      }}
    />
  </div>;
}

function parseFileDiff(patch: string): FileDiffMetadata | undefined {
  try {
    return parsePatchFiles(patch, `artifact:${patch.length}`)
      .flatMap((patch) => patch.files)
      .at(0);
  } catch {
    return undefined;
  }
}

const pierreStudioCss = `
:host {
  --diffs-font-family: var(--font-code);
  --diffs-header-font-family: var(--font-ui);
  --diffs-font-size: var(--type-code-size);
  --diffs-bg: var(--color-surface);
  --diffs-light-bg: var(--color-surface);
  --diffs-bg-context: var(--color-surface);
  --diffs-bg-context-number: var(--color-surface-subtle);
  --diffs-bg-addition: var(--color-success-surface);
  --diffs-bg-addition-number: color-mix(in srgb, var(--color-success-surface), var(--color-success) 10%);
  --diffs-bg-deletion: var(--color-danger-surface);
  --diffs-bg-deletion-number: color-mix(in srgb, var(--color-danger-surface), var(--color-danger) 10%);
  --diffs-token-light-bg: transparent;
  font-size: var(--diffs-font-size);
}
[data-diffs-header] { display: none !important; }
[data-line-number-content], [data-column-number] {
  font-family: var(--diffs-header-font-family) !important;
  font-variant-numeric: tabular-nums;
}
`;
