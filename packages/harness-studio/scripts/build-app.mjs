// Bundle the React app with the repo-conventional esbuild-wasm toolchain.
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild-wasm";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(packageRoot, "dist", "app");
const inspectorAssetRoot = join(packageRoot, "..", "..", "scripts", "harness-inspector", "ui");

await mkdir(join(appDir, "assets"), { recursive: true });
await build({
  entryPoints: { app: join(packageRoot, "src", "app", "main.tsx") },
  outdir: join(appDir, "assets"),
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  sourcemap: true,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
// The artifact host is a separate IIFE bundle, not a chunk of the shell: it runs
// inside the sandboxed artifact iframe, which has an opaque origin and can load
// a classic script without CORS but not a module script.
await build({
  entryPoints: { "artifact-host": join(packageRoot, "src", "app", "artifact-host.ts") },
  outdir: join(appDir, "assets"),
  entryNames: "[name]",
  bundle: true,
  format: "iife",
  globalName: "harnessArtifactHost",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: true,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
await Promise.all([
  copyFile(join(packageRoot, "src", "app", "index.html"), join(appDir, "index.html")),
  copyFile(join(packageRoot, "src", "app", "artifact-host.html"), join(appDir, "artifact-host.html")),
  ...["tokens.css", "shell.css", "workbench.css"].map((file) =>
    copyFile(join(packageRoot, "src", "app", "styles", file), join(appDir, "assets", file)),
  ),
  copyFile(join(inspectorAssetRoot, "workbench.css"), join(appDir, "assets", "inspector-workbench.css")),
  copyFile(join(inspectorAssetRoot, "workbench.js"), join(appDir, "assets", "inspector-workbench.js")),
]);
process.stdout.write(`Built studio app into ${appDir}\n`);
process.exit(0);
