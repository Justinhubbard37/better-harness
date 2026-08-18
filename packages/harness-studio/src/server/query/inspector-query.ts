import { readFile } from "node:fs/promises";

/** Reads a self-contained Harness Inspector HTML report as raw text. */
export async function loadInspectorReport(reportPath: string): Promise<string> {
  return readFile(reportPath, "utf8");
}
