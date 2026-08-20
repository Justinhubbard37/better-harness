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
await Promise.all([
  copyFile(join(packageRoot, "src", "app", "index.html"), join(appDir, "index.html")),
  ...["tokens.css", "shell.css", "workbench.css"].map((file) =>
    copyFile(join(packageRoot, "src", "app", "styles", file), join(appDir, "assets", file)),
  ),
  copyFile(join(inspectorAssetRoot, "workbench.css"), join(appDir, "assets", "inspector-workbench.css")),
]);
process.stdout.write(`Built studio app into ${appDir}\n`);
process.exit(0);
