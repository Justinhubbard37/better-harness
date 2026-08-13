import path from "node:path";
import { fileURLToPath } from "node:url";

function escapeCommandData(value) {
  return String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function escapeCommandProperty(value) {
  return escapeCommandData(value)
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

function errorDetail(error) {
  const cause = error?.cause ?? error;
  if (!cause) return "Test failed without an error detail.";
  return String(cause.stack ?? cause.message ?? cause).slice(0, 6000);
}

function repositoryPath(file, cwd) {
  if (!file) return null;
  const filePath = file.startsWith("file:") ? fileURLToPath(file) : file;
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".."
    ? relative.split(path.sep).join("/")
    : filePath.split(path.sep).join("/");
}

export function githubFailureAnnotation(data, { cwd = process.cwd() } = {}) {
  const properties = [];
  const file = repositoryPath(data.file, cwd);
  if (file) properties.push(`file=${escapeCommandProperty(file)}`);
  if (Number.isInteger(data.line)) properties.push(`line=${data.line}`);
  if (Number.isInteger(data.column)) properties.push(`col=${data.column}`);
  properties.push(`title=${escapeCommandProperty(`Test failed: ${data.name}`)}`);
  return `::error ${properties.join(",")}::${escapeCommandData(errorDetail(data.details?.error))}\n`;
}

export function plainFailure(data, { cwd = process.cwd() } = {}) {
  const file = repositoryPath(data.file, cwd) ?? "unknown file";
  const location = Number.isInteger(data.line) ? `${file}:${data.line}` : file;
  return `\nFAIL ${location} — ${data.name}\n${errorDetail(data.details?.error)}\n`;
}

export default async function* githubActionsReporter(source) {
  const seen = new Set();
  for await (const event of source) {
    if (event.type === "test:pass" && !event.data.skip && !event.data.todo) {
      yield ".";
      continue;
    }
    if (event.type === "test:summary") {
      yield "\n";
      continue;
    }
    if (event.type !== "test:fail" || event.data.skip || event.data.todo) continue;
    const key = `${event.data.file ?? ""}:${event.data.line ?? ""}:${event.data.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    yield "X";
    yield process.env.GITHUB_ACTIONS === "true"
      ? githubFailureAnnotation(event.data)
      : plainFailure(event.data);
  }
}
