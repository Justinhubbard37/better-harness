import { useMemo } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import type { DebuggerDiff } from "./session-debugger-model.js";
import { buildDebuggerPatch } from "./code-rendering-model.js";

export default function StudioDiff({ diff }: { diff: DebuggerDiff }): React.JSX.Element {
  const fileDiff = useMemo(() => parseFileDiff(diff), [diff]);
  if (fileDiff === undefined) {
    return <pre className="studio-diff-fallback">{buildDebuggerPatch(diff)}</pre>;
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

function parseFileDiff(diff: DebuggerDiff): FileDiffMetadata | undefined {
  try {
    return parsePatchFiles(buildDebuggerPatch(diff), `session-debugger:${diff.path}:${diff.before.length}:${diff.after.length}`)
      .flatMap((patch) => patch.files)
      .at(0);
  } catch {
    return undefined;
  }
}

const pierreStudioCss = `
:host {
  --diffs-font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  --diffs-header-font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --diffs-font-size: 13px;
  --diffs-bg: #ffffff;
  --diffs-light-bg: #ffffff;
  --diffs-bg-context: #ffffff;
  --diffs-bg-context-number: #f7f9fc;
  --diffs-bg-addition: #ecf8f1;
  --diffs-bg-addition-number: #dff2e7;
  --diffs-bg-deletion: #fff0f0;
  --diffs-bg-deletion-number: #f8dede;
  --diffs-token-light-bg: transparent;
  font-size: var(--diffs-font-size);
}
[data-diffs-header] { display: none !important; }
[data-line-number-content], [data-column-number] {
  font-family: var(--diffs-header-font-family) !important;
  font-variant-numeric: tabular-nums;
}
`;
