import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExternalArtifactProvider } from "../../../contracts/artifact.js";

const MAX_PROVIDER_MODULES = 16;
const PACKAGE_SPECIFIER = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;

interface ArtifactProviderModule {
  readonly createArtifactProvider?: () => ExternalArtifactProvider | Promise<ExternalArtifactProvider>;
}

/** Load explicit operator-provisioned modules before Studio opens a port. */
export async function loadArtifactProviderModules(
  specifiers: readonly string[],
  cwd: string,
): Promise<readonly ExternalArtifactProvider[]> {
  if (specifiers.length > MAX_PROVIDER_MODULES) {
    throw new Error(`At most ${MAX_PROVIDER_MODULES} Artifact Provider modules may be loaded.`);
  }
  const seen = new Set<string>();
  const providers: ExternalArtifactProvider[] = [];
  for (const specifier of specifiers) {
    const target = providerModuleTarget(specifier, cwd);
    if (seen.has(target)) throw new Error(`Artifact Provider module '${specifier}' was supplied more than once.`);
    seen.add(target);
    const loaded: unknown = await import(target);
    if (loaded === null || typeof loaded !== "object") {
      throw new Error(`Artifact Provider module '${specifier}' has no module exports.`);
    }
    const factory = (loaded as ArtifactProviderModule).createArtifactProvider;
    if (typeof factory !== "function") {
      throw new Error(`Artifact Provider module '${specifier}' must export createArtifactProvider().`);
    }
    const provider = await factory();
    if (provider === null || typeof provider !== "object") {
      throw new Error(`Artifact Provider module '${specifier}' returned an invalid Provider.`);
    }
    providers.push(provider);
  }
  return Object.freeze(providers);
}

export function providerModuleTarget(specifier: string, cwd: string): string {
  if (specifier.trim() !== specifier || specifier.length === 0) {
    throw new Error("Artifact Provider module specifiers must be non-empty and contain no surrounding whitespace.");
  }
  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    return pathToFileURL(resolve(cwd, specifier)).href;
  }
  if (!PACKAGE_SPECIFIER.test(specifier)) {
    throw new Error(`Artifact Provider module '${specifier}' must be a package name or filesystem path.`);
  }
  return specifier;
}
