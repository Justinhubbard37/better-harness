#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startHarnessStudioServer } from "./server.js";

const HELP = `harness-studio — local studio for harness runs and compare evidence

Usage:
  harness-studio [options]
  harness-studio --help

Options:
  --evidence <dir>    harness-compare evidence directory (enables Compare view)
  --harness <file>    .harness file to serve for live runs (enables Run view)
  --harness-id <id>   Harness to resolve (default: the file's only harness)
  --runtime <id>      Target runtime (default: the file's only target)
  --port <n>          Listen port (default: 3311)
  --host <addr>       Bind address (default: 127.0.0.1)
  --cwd <dir>         Working directory for executor runs (default: process cwd)
  --source-root <dir> Root a 'source' skill's path locks and delivers against
                      (default: the directory containing --harness)
  --unsafe-allow-remote
                      Permit a non-loopback --host. The studio's /agui endpoint is
                      unauthenticated and runs a coding agent in --cwd.
  -h, --help          Print help without reading any file or opening a port
`;

export interface HarnessStudioCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Resolve the skill root owned by an optional `.harness` document. */
export function resolveHarnessStudioSourceRoot(
  harness: string | undefined,
  explicitRoot?: string,
): string | undefined {
  return explicitRoot ?? (harness !== undefined ? dirname(resolve(harness)) : undefined);
}

interface ParsedArgs {
  evidence?: string;
  harness?: string;
  harnessId?: string;
  runtime?: string;
  port: number;
  host: string;
  allowRemote: boolean;
  cwd?: string;
  sourceRoot?: string;
  help: boolean;
  error?: string;
}

export function parseHarnessStudioArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { port: 3311, host: "127.0.0.1", allowRemote: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const takeValue = (): string | undefined => {
      index += 1;
      return argv[index];
    };
    switch (arg) {
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "--evidence":
        parsed.evidence = takeValue();
        break;
      case "--harness":
        parsed.harness = takeValue();
        break;
      case "--harness-id":
        parsed.harnessId = takeValue();
        break;
      case "--runtime":
        parsed.runtime = takeValue();
        break;
      case "--host":
        parsed.host = takeValue() ?? parsed.host;
        break;
      case "--unsafe-allow-remote":
        parsed.allowRemote = true;
        break;
      case "--cwd":
        parsed.cwd = takeValue();
        break;
      case "--source-root":
        parsed.sourceRoot = takeValue();
        break;
      case "--port": {
        const value = Number(takeValue());
        if (!Number.isInteger(value) || value < 0 || value > 65535) {
          parsed.error = "--port must be an integer between 0 and 65535.";
        } else {
          parsed.port = value;
        }
        break;
      }
      default:
        parsed.error = `Unknown option '${arg}'.`;
    }
  }
  return parsed;
}

/** The built React app ships next to the compiled server inside dist/. */
export function defaultAppDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "app");
}

/** In-process CLI entry; returns the exit code (0 keeps the server running). */
export async function runHarnessStudioCli(argv: string[], io: HarnessStudioCliIo): Promise<number> {
  const parsed = parseHarnessStudioArgs(argv);
  if (parsed.help) {
    io.stdout(HELP);
    return 0;
  }
  if (parsed.error !== undefined) {
    io.stderr(`${parsed.error}\n`);
    return 2;
  }
  if (parsed.evidence === undefined && parsed.harness === undefined) {
    io.stderr("Nothing to show: pass --evidence <dir>, --harness <file.harness>, or both (see --help).\n");
    return 2;
  }
  const harnessSource = parsed.harness !== undefined ? await readFile(parsed.harness, "utf8") : undefined;
  // Skills are conventionally declared relative to their `.harness` file (see
  // examples/*.harness), so loading one without a flag still delivers them.
  const sourceRoot = resolveHarnessStudioSourceRoot(parsed.harness, parsed.sourceRoot);
  const started = await startHarnessStudioServer({
    appDir: defaultAppDir(),
    port: parsed.port,
    host: parsed.host,
    allowRemote: parsed.allowRemote,
    ...(parsed.evidence !== undefined ? { evidenceDir: resolve(parsed.evidence) } : {}),
    ...(harnessSource !== undefined ? { harnessSource } : {}),
    ...(parsed.harnessId !== undefined ? { harnessId: parsed.harnessId } : {}),
    ...(parsed.runtime !== undefined ? { runtimeId: parsed.runtime } : {}),
    ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
    ...(sourceRoot !== undefined ? { sourceRoot } : {}),
  });
  if (parsed.allowRemote) {
    io.stderr(
      `Warning: ${started.url} is reachable beyond loopback and has no authentication. ` +
        `Anyone who can route to it can run a coding agent in ${parsed.cwd ?? process.cwd()}.\n`,
    );
  }
  io.stdout(`Harness Studio: ${started.url}\n`);
  return 0;
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runHarnessStudioCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }).then(
    (code) => {
      if (code !== 0) {
        process.exit(code);
      }
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
