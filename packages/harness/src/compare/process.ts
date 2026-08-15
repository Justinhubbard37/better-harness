import { spawn } from "node:child_process";

export interface CommandResult {
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

const MAX_CAPTURE_BYTES = 1_000_000;

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  const started = Date.now();
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current) >= MAX_CAPTURE_BYTES) return current;
      const remaining = MAX_CAPTURE_BYTES - Buffer.byteLength(current);
      return current + chunk.subarray(0, remaining).toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveResult({
        command: [command, ...args],
        exitCode: code ?? 1,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}
