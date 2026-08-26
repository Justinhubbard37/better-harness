import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const agent = resolve(dirname(fileURLToPath(import.meta.url)), "acp-agent.mjs");
const result = spawnSync(process.execPath, [agent], {
  stdio: "inherit",
  windowsHide: true,
});
process.exit(result.status ?? 1);
