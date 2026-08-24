import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
import type {
  XlsxCellSnapshot,
  XlsxMergedRange,
  XlsxWorksheetSnapshot,
} from "../../../artifact-model.js";
import { ArtifactDiagnostics } from "../ArtifactDiagnostics.js";
import type { ArtifactSurfaceMountContext } from "../ArtifactSurface.js";
import { useArtifactSnapshot } from "../useArtifactSnapshot.js";

export function XlsxArtifactView({ artifact }: ArtifactSurfaceMountContext): React.JSX.Element {
  const { snapshot, failure } = useArtifactSnapshot(artifact, "xlsx/v1", "XLSX");
  const [sheetRequest, setSheetRequest] = useState<{ revisionId: string; sheetIndex: number }>();
  const [selection, setSelection] = useState<{ revisionId: string; address: string }>();
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const requestedSheetIndex = sheetRequest?.revisionId === artifact.revision.id ? sheetRequest.sheetIndex : undefined;
  const selectedAddress = selection?.revisionId === artifact.revision.id ? selection.address : undefined;
  const setSelectedAddress = (address: string): void => {
    setSelection({ revisionId: artifact.revision.id, address });
  };

  if (failure !== undefined) return <p className="artifact-status" role="alert">{failure}</p>;
  if (snapshot === undefined) return <p className="artifact-status" role="status">Adapting XLSX revision…</p>;

  const sheetIndex = requestedSheetIndex ?? snapshot.payload.activeSheetIndex;
  const sheet = snapshot.payload.sheets[Math.min(sheetIndex, snapshot.payload.sheets.length - 1)];
  if (sheet === undefined) return <p className="artifact-status" role="alert">The XLSX snapshot has no worksheets.</p>;
  const selectedCell = selectedAddress === undefined ? undefined : sheet.cells.find((cell) => cell.address === selectedAddress);
  return <div className="xlsx-artifact-viewer">
    <header className="xlsx-formula-bar">
      <strong>{selectedAddress ?? sheet.label}</strong>
      <span>{selectedCell?.formula === undefined ? (selectedCell?.display ?? "Read-only workbook") : `=${selectedCell.formula}`}</span>
    </header>
    <div ref={setScrollElement} className="xlsx-grid-scroll" aria-label={`${sheet.label} worksheet`}>
      <XlsxGrid sheet={sheet} selectedAddress={selectedAddress} onSelect={setSelectedAddress} scrollElement={scrollElement} />
    </div>
    <nav className="xlsx-sheet-tabs" aria-label="Worksheets">
      {snapshot.payload.sheets.map((candidate, index) => <button
        key={candidate.id}
        type="button"
        className={candidate.id === sheet.id ? "selected" : undefined}
        aria-current={candidate.id === sheet.id}
        onClick={() => {
          setSheetRequest({ revisionId: artifact.revision.id, sheetIndex: index });
          setSelection(undefined);
        }}
      >{candidate.label}</button>)}
    </nav>
    <footer className="xlsx-diagnostics">
      <span>{snapshot.adapter.id}@{snapshot.adapter.version} · Read-only</span>
      <ArtifactDiagnostics diagnostics={snapshot.diagnostics} />
    </footer>
  </div>;
}

function XlsxGrid(props: {
  sheet: XlsxWorksheetSnapshot;
  selectedAddress?: string;
  onSelect: (address: string) => void;
  scrollElement: HTMLDivElement | null;
}): React.JSX.Element {
  const model = useMemo(() => gridModel(props.sheet), [props.sheet]);
  const rowVirtualizer = useVirtualizer({
    count: props.sheet.rowCount,
    getScrollElement: () => props.scrollElement,
    estimateSize: (index) => rowHeight(props.sheet, index + 1),
    overscan: 8,
  });
  const rows = rowVirtualizer.getVirtualItems();
  const topSpacer = rows[0]?.start ?? 0;
  const bottomSpacer = rows.length === 0 ? 0 : rowVirtualizer.getTotalSize() - rows[rows.length - 1]!.end;
  return <table className="xlsx-grid" role="grid" aria-rowcount={props.sheet.rowCount} aria-colcount={props.sheet.columnCount}>
    <colgroup><col className="xlsx-row-number-column" />{Array.from({ length: props.sheet.columnCount }, (_, index) => <col key={index} style={{ width: `${columnWidth(props.sheet, index + 1)}px` }} />)}</colgroup>
    <thead><tr><th aria-hidden="true" />{Array.from({ length: props.sheet.columnCount }, (_, index) => <th key={index} scope="col">{columnLabel(index + 1)}</th>)}</tr></thead>
    <tbody>
      {topSpacer > 0 && <tr className="xlsx-virtual-spacer" aria-hidden="true"><td colSpan={props.sheet.columnCount + 1} style={{ height: `${topSpacer}px` }} /></tr>}
      {rows.map((virtualRow) => {
      const row = virtualRow.index + 1;
      return <tr key={row} data-index={virtualRow.index} ref={rowVirtualizer.measureElement} style={{ height: `${rowHeight(props.sheet, row)}px` }}>
        <th scope="row">{row}</th>
        {Array.from({ length: props.sheet.columnCount }, (_, columnOffset) => {
          const column = columnOffset + 1;
          const key = coordinateKey(row, column);
          if (model.covered.has(key)) return undefined;
          const cell = model.cells.get(key);
          const merge = model.merges.get(key);
          const address = cell?.address ?? `${columnLabel(column)}${row}`;
          const selected = address === props.selectedAddress;
          return <td
            key={column}
            role="gridcell"
            tabIndex={selected || (props.selectedAddress === undefined && row === 1 && column === 1) ? 0 : -1}
            aria-selected={selected}
            aria-label={`${address}${cell?.display === undefined || cell.display === "" ? "" : ` ${cell.display}`}`}
            data-row={row}
            data-column={column}
            data-address={address}
            colSpan={merge === undefined ? undefined : merge.endColumn - merge.startColumn + 1}
            rowSpan={merge === undefined ? undefined : merge.endRow - merge.startRow + 1}
            className={selected ? "selected" : undefined}
            style={cellStyle(cell)}
            onClick={() => props.onSelect(address)}
            onKeyDown={(event) => handleCellKeyDown(
              event,
              address,
              props.sheet.rowCount,
              props.sheet.columnCount,
              props.onSelect,
              (index, options) => rowVirtualizer.scrollToIndex(index, options),
            )}
          >{cell?.display ?? ""}</td>;
        })}
      </tr>;
      })}
      {bottomSpacer > 0 && <tr className="xlsx-virtual-spacer" aria-hidden="true"><td colSpan={props.sheet.columnCount + 1} style={{ height: `${bottomSpacer}px` }} /></tr>}
    </tbody>
  </table>;
}

function gridModel(sheet: XlsxWorksheetSnapshot): {
  cells: Map<string, XlsxCellSnapshot>;
  merges: Map<string, XlsxMergedRange>;
  covered: Set<string>;
} {
  const cells = new Map(sheet.cells.map((cell) => [coordinateKey(cell.row, cell.column), cell]));
  const merges = new Map<string, XlsxMergedRange>();
  const covered = new Set<string>();
  for (const merge of sheet.mergedRanges) {
    const anchor = coordinateKey(merge.startRow, merge.startColumn);
    merges.set(anchor, merge);
    for (let row = merge.startRow; row <= merge.endRow; row += 1) {
      for (let column = merge.startColumn; column <= merge.endColumn; column += 1) {
        const key = coordinateKey(row, column);
        if (key !== anchor) covered.add(key);
      }
    }
  }
  return { cells, merges, covered };
}

function handleCellKeyDown(
  event: KeyboardEvent<HTMLTableCellElement>,
  address: string,
  rowCount: number,
  columnCount: number,
  onSelect: (address: string) => void,
  scrollToRow: (index: number, options?: { align?: "auto" | "center" | "end" | "start" }) => void,
): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onSelect(address);
    return;
  }
  const delta = ({
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
    ArrowUp: [-1, 0],
  } as const)[event.key as "ArrowDown" | "ArrowLeft" | "ArrowRight" | "ArrowUp"];
  if (delta === undefined) return;
  event.preventDefault();

  const grid = event.currentTarget.closest<HTMLElement>("[role='grid']");
  let row = Number(event.currentTarget.dataset.row) + delta[0];
  let column = Number(event.currentTarget.dataset.column) + delta[1];
  while (row >= 1 && row <= rowCount && column >= 1 && column <= columnCount) {
    let target = grid?.querySelector<HTMLElement>(`[role='gridcell'][data-row='${row}'][data-column='${column}']`);
    if (target !== undefined && target !== null) {
      const targetAddress = target.dataset.address;
      if (targetAddress !== undefined) onSelect(targetAddress);
      target.focus();
      return;
    }
    const address = `${columnLabel(column)}${row}`;
    onSelect(address);
    scrollToRow(row - 1, { align: "auto" });
    globalThis.requestAnimationFrame?.(() => {
      target = grid?.querySelector<HTMLElement>(`[role='gridcell'][data-row='${row}'][data-column='${column}']`);
      target?.focus();
    });
    return;
  }
}

function cellStyle(cell: XlsxCellSnapshot | undefined): CSSProperties | undefined {
  const style = cell?.style;
  if (style === undefined) return undefined;
  return {
    ...(style.fill === undefined ? {} : { backgroundColor: style.fill }),
    ...(style.color === undefined ? {} : { color: style.color }),
    ...(style.fontFamily === undefined ? {} : { fontFamily: `${JSON.stringify(style.fontFamily)}, system-ui, sans-serif` }),
    ...(style.fontSizePoints === undefined ? {} : { fontSize: `${style.fontSizePoints}pt` }),
    ...(style.bold === true ? { fontWeight: 700 } : {}),
    ...(style.italic === true ? { fontStyle: "italic" } : {}),
    ...(style.horizontalAlignment === undefined ? {} : { textAlign: style.horizontalAlignment }),
    ...(style.verticalAlignment === undefined ? {} : { verticalAlign: style.verticalAlignment }),
    ...(style.wrapText === true ? { whiteSpace: "normal", overflowWrap: "anywhere" } : {}),
  };
}

function columnWidth(sheet: XlsxWorksheetSnapshot, index: number): number {
  const width = sheet.columns.find((column) => column.index === index)?.width;
  return width === undefined ? 96 : Math.min(320, Math.max(48, Math.round(width * 7 + 12)));
}

function rowHeight(sheet: XlsxWorksheetSnapshot, index: number): number {
  const height = sheet.rows.find((row) => row.index === index)?.height;
  return height === undefined ? 24 : Math.min(160, Math.max(24, Math.round(height * 4 / 3)));
}

function coordinateKey(row: number, column: number): string {
  return `${row}:${column}`;
}

function columnLabel(column: number): string {
  let value = column;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}
